import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { Place } from "@urban/core";
import { calculateImpact, createProject } from "@urban/models";
import { createPostgresSecurityFixture } from "./postgres-security-fixture.js";
import { emptyState, type DataState, type ProjectRecord } from "./store.js";
import { digest, encodeRecord } from "./storage-core.js";
import { tokenHash } from "./security.js";
import { initialEngagement } from "./engagement.js";
import { assertPostgresRuntimeRole } from "./postgres-security.js";

const connection = process.env.TEST_DATABASE_URL;
const at = "2026-11-05T00:00:00.000Z";
const session = (actor: string) => tokenHash(`isolated-sql-security:${actor}`);
function place(id: string): Place {
  return {
    id,
    name: id,
    city: "Synthetic test area",
    state: "AZ",
    zip: "85004",
    center: [-112.07, 33.46],
    bounds: [-112.08, 33.45, -112.06, 33.47],
    boundary: [
      [-112.08, 33.45],
      [-112.06, 33.45],
      [-112.06, 33.47],
      [-112.08, 33.47],
      [-112.08, 33.45],
    ],
    buildings: [],
    roads: [],
    sources: [],
    coverage: [],
    loadedAt: at,
    extentLabel: "Synthetic security fixture; not real geographic coverage",
  };
}
function securityState(): DataState {
  const state = emptyState();
  const memberships = [
    ["owner-a", "org-a", "owner", "workspace"],
    ["member-a", "org-a", "editor", "workspace"],
    // Deliberately hostile legacy membership: project-only owner is not an org admin.
    ["project-owner", "org-a", "owner", "project-only"],
    ["project-editor", "org-a", "viewer", "project-only"],
    ["project-commenter", "org-a", "viewer", "project-only"],
    ["project-viewer", "org-a", "viewer", "project-only"],
    ["revoked-viewer", "org-a", "viewer", "project-only"],
    ["sibling-only", "org-a", "viewer", "project-only"],
    ["owner-b", "org-b", "owner", "workspace"],
    ["participant", "org-b", "viewer", "workspace"],
    ["other-participant", "org-b", "viewer", "workspace"],
  ] as const;
  for (const id of ["org-a", "org-b"])
    state.organizations.push({ id, name: id, createdAt: at });
  for (const [userId, organizationId, role, scope] of memberships) {
    state.users.push({
      id: userId,
      email: `${userId}@security.test`,
      name: userId,
      passwordHash: `secret-password-marker:${userId}`,
      createdAt: at,
    });
    state.memberships.push({ userId, organizationId, role, scope });
    state.sessions.push({
      hash: session(userId),
      userId,
      organizationId,
      csrfToken: `secret-csrf-marker:${userId}`,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  }
  state.sessions.push(
    {
      hash: session("expired"),
      userId: "owner-a",
      organizationId: "org-a",
      csrfToken: "expired-token",
      expiresAt: "2000-01-01T00:00:00.000Z",
    },
    {
      hash: session("logout"),
      userId: "owner-a",
      organizationId: "org-a",
      csrfToken: "logout-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  );
  for (const [id, organizationId, baselineId] of [
    ["a-private", "org-a", "a-captured"],
    ["a-sibling", "org-a", "a-unpublished-secret"],
    ["a-legacy", "org-a", "a-legacy-captured"],
    ["b-private", "org-b", "b-unpublished-secret"],
  ]) {
    const baseline = place(baselineId),
      project = createProject(baseline);
    project.id = id;
    project.name = id;
    const owner = organizationId === "org-a" ? "owner-a" : "owner-b";
    const record: ProjectRecord = {
      organizationId,
      project,
      baseline,
      version: 1,
      createdBy: owner,
      createdAt: at,
    };
    if (id !== "a-legacy") {
      record.acl = {
        version: 1,
        members: [
          { userId: owner, role: "owner", addedAt: at, addedBy: owner },
        ],
      };
      if (id === "a-private")
        for (const [userId, role] of [
          ["project-owner", "owner"],
          ["project-editor", "editor"],
          ["project-commenter", "commenter"],
          ["project-viewer", "viewer"],
          ["revoked-viewer", "viewer"],
        ] as const)
          record.acl.members.push({
            userId,
            role,
            addedAt: at,
            addedBy: owner,
          });
      if (id === "a-sibling")
        record.acl.members.push({
          userId: "sibling-only",
          role: "viewer",
          addedAt: at,
          addedBy: owner,
        });
    }
    state.projects.push(record);
    state.comments.push({
      id: `comment-${id}`,
      projectId: id,
      organizationId,
      actorId: owner,
      author: owner,
      text: `private-discussion-marker:${id}`,
      scenarioId: project.scenarios[1].id,
      createdAt: at,
      scenarioRevision: 0,
      projectVersion: 1,
      threadVersion: 1,
      replies: [],
    });
    state.audit.push({
      id: `audit-${id}`,
      projectId: id,
      organizationId,
      actorId: owner,
      action: "fixture.created",
      at,
      details: {},
    });
  }
  const original = state.projects.find((p) => p.project.id === "a-private")!;
  state.comments.push({
    ...structuredClone(state.comments[0]),
    id: "resolved-a-private",
    resolved: true,
    resolvedBy: "owner-a",
    resolvedAt: at,
  });
  for (const id of [
    "public-a",
    "other-public-a",
    "revoked-a",
    "closed-a",
    "disabled-a",
  ]) {
    const scenario = structuredClone(original.project.scenarios[1]);
    state.published.push({
      id,
      organizationId: "org-a",
      projectId: original.project.id,
      projectName: original.project.name,
      placeId: original.baseline.id,
      baseline: structuredClone(original.baseline),
      scenario,
      results: calculateImpact(original.baseline, scenario),
      createdAt: at,
      feedbackEnabled: true,
      engagementRequiresVersion: true,
      engagement: {
        config: {
          introduction: "Published fixture",
          comments: id !== "disabled-a",
          votes: true,
          pins: true,
          questions: [],
        },
        collection: {
          status: id === "revoked-a" || id === "closed-a" ? "closed" : "open",
          version: 1,
          updatedAt: at,
        },
      },
      ...(id === "revoked-a" ? { revokedAt: at } : {}),
    });
  }
  const legacyPublication = {
    ...structuredClone(state.published[0]),
    id: "legacy-a",
  };
  delete legacyPublication.engagement;
  delete legacyPublication.engagementRequiresVersion;
  state.published.push(legacyPublication);
  for (const userId of ["participant", "other-participant"])
    state.publicFeedback.push({
      id: `feedback-${userId}`,
      snapshotId: "public-a",
      userId,
      kind: "comment",
      text: `response-marker:${userId}`,
      createdAt: at,
      moderation: {
        status: "included",
        version: 1,
        reason: `private-moderation-marker:${userId}`,
        updatedAt: at,
      },
    });
  state.publicFeedback.push(
    {
      id: "vote-old",
      snapshotId: "public-a",
      userId: "participant",
      kind: "vote",
      vote: "support",
      createdAt: "2026-11-01T00:00:00Z",
      supersededAt: "2026-11-02T00:00:00Z",
      moderation: { status: "pending", version: 1 },
    },
    {
      id: "vote-current",
      snapshotId: "public-a",
      userId: "participant",
      kind: "vote",
      vote: "concern",
      createdAt: "2026-11-02T00:00:00Z",
      moderation: { status: "pending", version: 1 },
    },
  );
  return state;
}

type Fixture = Awaited<ReturnType<typeof createPostgresSecurityFixture>>;
type Context = { actor?: string; publicSnapshot?: string; purpose?: string };
const ids = async (client: pg.PoolClient, table: string) =>
  (
    await client.query<{ id: string }>(`SELECT id FROM ${table} ORDER BY id`)
  ).rows.map((row) => row.id);

describe.skipIf(!connection)(
  "Database-enforced isolation through restricted SQL logins",
  () => {
    const original = securityState();
    let fixture: Fixture;
    let web: pg.Pool;
    let auth: pg.Pool;
    let worker: pg.Pool;
    beforeAll(async () => {
      fixture = await createPostgresSecurityFixture(connection!, {
        state: original,
        platformAdminUserIds: ["owner-a"],
      });
      web = new pg.Pool({ connectionString: fixture.webURL, max: 1 });
      auth = new pg.Pool({ connectionString: fixture.authURL, max: 1 });
      worker = new pg.Pool({ connectionString: fixture.workerURL, max: 1 });
    }, 30_000);
    afterAll(async () => {
      await Promise.all([web?.end(), auth?.end(), worker?.end()]);
      await fixture?.close();
    }, 30_000);

    async function setContext(client: pg.PoolClient, context: Context = {}) {
      for (const [key, value] of Object.entries({
        "urban.session_hash": context.actor ? session(context.actor) : "",
        "urban.public_snapshot_id": context.publicSnapshot ?? "",
        "urban.purpose": context.purpose ?? "",
        "urban.auth_email": "",
        "urban.auth_user_id": "",
        "urban.auth_organization_id": "",
        "urban.auth_session_hash": "",
      }))
        await client.query("SELECT set_config($1,$2,true)", [key, value]);
    }
    async function as<T>(
      context: Context,
      operation: (client: pg.PoolClient) => Promise<T>,
      pool = web,
      commit = false,
    ) {
      const client = await pool.connect();
      let succeeded = false;
      try {
        await client.query("BEGIN");
        await setContext(client, context);
        const result = await operation(client);
        succeeded = true;
        return result;
      } finally {
        try {
          await client.query(commit && succeeded ? "COMMIT" : "ROLLBACK");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      }
    }
    async function denied(
      client: pg.PoolClient,
      sql: string,
      parameters: unknown[] = [],
      codes = ["42501", "23514", "55000"],
      checkDeferred = false,
    ) {
      await client.query("SAVEPOINT forbidden_statement");
      let failure: unknown;
      try {
        await client.query(sql, parameters);
        if (checkDeferred) await client.query("SET CONSTRAINTS ALL IMMEDIATE");
      } catch (error) {
        failure = error;
      }
      await client.query("ROLLBACK TO SAVEPOINT forbidden_statement");
      await client.query("RELEASE SAVEPOINT forbidden_statement");
      expect(
        failure,
        `Restricted SQL unexpectedly succeeded: ${sql}`,
      ).toBeDefined();
      expect(codes).toContain((failure as { code?: string }).code);
    }

    it("connects as genuinely restricted logins with enabled and forced RLS", async () => {
      for (const [pool, expectedRole] of [
        [web, fixture.roles.webRole],
        [auth, fixture.roles.authRole],
        [worker, fixture.roles.workerRole],
      ] as const) {
        const result = await pool.query(
          "SELECT session_user,current_user,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=current_user",
        );
        expect(result.rows[0]).toEqual({
          session_user: expectedRole,
          current_user: expectedRole,
          rolsuper: false,
          rolbypassrls: false,
          rolcreaterole: false,
          rolcreatedb: false,
        });

        const owned = await pool.query(
          "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)",
          [fixture.schema],
        );
        expect(owned.rows[0].count).toBe("0");
      }
      const policies = await web.query(
        "SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND relname=ANY($2::text[])",
        [
          fixture.schema,
          [
            "app_projects",
            "app_comments",
            "app_published",
            "app_public_feedback",
            "app_project_versions",
            "app_baseline_snapshots",
          ],
        ],
      );
      expect(policies.rows).toHaveLength(6);
      for (const row of policies.rows)
        expect(row).toMatchObject({
          relrowsecurity: true,
          relforcerowsecurity: true,
        });
    });

    it("fails startup if a previously secured application table has row security disabled", async () => {
      const client = await web.connect();
      try {
        await assertPostgresRuntimeRole(client, "web");
        await fixture.admin.query(
          "ALTER TABLE app_projects DISABLE ROW LEVEL SECURITY",
        );
        await expect(
          assertPostgresRuntimeRole(client, "web"),
        ).rejects.toThrow();
      } finally {
        await fixture.admin.query(
          "ALTER TABLE app_projects ENABLE ROW LEVEL SECURITY",
        );
        await fixture.admin.query(
          "ALTER TABLE app_projects FORCE ROW LEVEL SECURITY",
        );
        client.release();
      }
      const restored = await web.connect();
      try {
        await assertPostgresRuntimeRole(restored, "web");
      } finally {
        restored.release();
      }
    });

    it("restricts unfiltered project, discussion, audit and history queries by actual membership and ACL", async () => {
      for (const [actor, expected] of [
        ["owner-a", ["a-legacy", "a-private", "a-sibling"]],
        ["owner-b", ["b-private"]],
        ["project-owner", ["a-private"]],
        ["project-editor", ["a-private"]],
        ["project-commenter", ["a-private"]],
        ["project-viewer", ["a-private"]],
        ["member-a", ["a-legacy"]],
        ["participant", []],
      ] as const)
        await as({ actor }, async (client) => {
          expect(await ids(client, "app_projects")).toEqual(expected);
          expect(await ids(client, "app_comments")).toEqual(
            original.comments
              .filter((comment) =>
                (expected as readonly string[]).includes(comment.projectId),
              )
              .map((comment) => comment.id)
              .sort(),
          );
          expect(await ids(client, "app_audit")).toEqual(
            expected.map((id) => `audit-${id}`),
          );
          await denied(
            client,
            "SELECT * FROM app_project_versions",
            [],
            ["42501"],
          );
        });
    });

    it("does not disclose unrelated private-project rosters to project-only recipients", async () => {
      await as({ actor: "project-owner" }, async (client) => {
        expect(await ids(client, "app_users")).not.toContain("sibling-only");
        const members = await client.query(
          "SELECT user_id FROM app_memberships",
        );
        expect(members.rows.map((row) => row.user_id)).not.toContain(
          "sibling-only",
        );
        expect(
          (
            await client.query(
              "SELECT app_security_user_header('sibling-only') AS profile",
            )
          ).rows[0].profile,
        ).toBeNull();
        expect(
          (
            await client.query(
              "SELECT app_security_user_header('owner-a') AS profile",
            )
          ).rows[0].profile,
        ).toMatchObject({ id: "owner-a" });
      });
    });

    it("does not let authentication or worker connections assume the web role's project access", async () => {
      for (const [pool, purpose] of [
        [auth, "auth.login"],
        [worker, "worker.prep"],
        [worker, "worker.budget"],
      ] as const)
        await as(
          { actor: "owner-a", purpose },
          async (client) => {
            for (const [key, value] of Object.entries({
              "urban.auth_user_id": "owner-a",
              "urban.auth_email": "owner-a@security.test",
              "urban.auth_organization_id": "org-a",
              "urban.auth_session_hash": session("owner-a"),
            }))
              await client.query("SELECT set_config($1,$2,true)", [key, value]);
            if (purpose !== "worker.budget")
              expect(
                (
                  await client.query(
                    "SELECT app_security_principal() AS principal",
                  )
                ).rows[0].principal,
              ).toMatchObject({ userId: "owner-a" });
            expect(await ids(client, "app_projects")).toEqual([]);
            expect(await ids(client, "app_comments")).toEqual([]);
            expect(
              (
                await client.query(
                  "UPDATE app_projects SET updated_at=now() WHERE id='a-private' RETURNING id",
                )
              ).rowCount,
            ).toBe(0);
            if (purpose !== "worker.budget") {
              // Preparation may inspect cost evidence, but still has no budget write authority.
              expect(await ids(client, "app_budget")).toEqual(
                purpose === "worker.prep" ? ["budget"] : [],
              );
              expect(
                (
                  await client.query(
                    "UPDATE app_budget SET updated_at=now() RETURNING id",
                  )
                ).rowCount,
              ).toBe(0);
            }
            await denied(
              client,
              `SET ROLE "${fixture.roles.webRole}"`,
              [],
              ["42501"],
            );
          },
          pool,
        );
    });

    it("does not turn arbitrary user, tenant, purpose or selector settings into authority", async () => {
      await as({ actor: "project-viewer" }, async (client) => {
        for (const [key, value] of Object.entries({
          "urban.user_id": "owner-b",
          "urban.organization_id": "org-b",
          "urban.purpose": "auth.lookup",
          "urban.auth_email": "owner-b@security.test",
          "urban.auth_user_id": "owner-b",
          "urban.auth_organization_id": "org-b",
          "urban.scope": '{"projects":{"all":true}}',
        }))
          await client.query("SELECT set_config($1,$2,true)", [key, value]);
        expect(await ids(client, "app_projects")).toEqual(["a-private"]);
        const profiles = await client.query("SELECT header FROM app_users");
        expect(JSON.stringify(profiles.rows)).not.toContain(
          "secret-password-marker:",
        );
        await client.query(
          "SELECT set_config('urban.purpose','worker.budget',true)",
        );
        expect(await ids(client, "app_budget")).toEqual([]);
        await client.query(
          "SELECT set_config('urban.session_hash','not-a-valid-credential',true)",
        );
        expect(await ids(client, "app_projects")).toEqual([]);
      });
      await as({ actor: "project-owner" }, async (client) => {
        await client.query(
          "SELECT set_config('urban.project_id','a-private',true)",
        );
        expect(
          (
            await client.query(
              "UPDATE app_memberships SET header=jsonb_set(jsonb_set(header,'{scope}','\"workspace\"'),'{role}','\"owner\"') WHERE user_id='project-owner' RETURNING id",
            )
          ).rowCount,
        ).toBe(0);
        expect(await ids(client, "app_projects")).toEqual(["a-private"]);
      });
      for (const actor of [undefined, "expired"])
        await as({ actor }, async (client) =>
          expect(await ids(client, "app_projects")).toEqual([]),
        );
    });

    it("keeps credentials, other sessions and the retained full-state document private", async () => {
      await as({ actor: "project-owner" }, async (client) => {
        const users = await client.query("SELECT * FROM app_users");
        expect(JSON.stringify(users.rows)).not.toContain(
          "secret-password-marker:",
        );
        const profile = await client.query(
          "SELECT app_security_user_header($1) AS profile",
          ["project-owner"],
        );
        expect(JSON.stringify(profile.rows)).not.toContain(
          "secret-password-marker:",
        );
        const sessions = await client.query("SELECT * FROM app_sessions");
        expect(sessions.rows.map((row) => row.id)).toEqual([
          session("project-owner"),
        ]);
        expect(JSON.stringify(sessions.rows)).not.toContain(
          "secret-csrf-marker:owner-b",
        );
        for (const table of [
          "app_state",
          "app_storage_manifest",
          "app_user_credentials",
          "app_feedback_moderation",
          "app_baseline_proofs",
          "app_security_config",
          "app_auth_bootstrap",
          "app_project_write_proofs",
        ])
          await denied(client, `SELECT * FROM ${table}`, [], ["42501"]);
      });
    });

    it("silently excludes foreign rows from UPDATE/DELETE and rejects cross-tenant inserts and UPSERT", async () => {
      await as({ actor: "owner-a" }, async (client) => {
        expect(
          (
            await client.query(
              "UPDATE app_projects SET updated_at=now() WHERE id='b-private' RETURNING id",
            )
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await client.query(
              "DELETE FROM app_comments WHERE project_id='b-private' RETURNING id",
            )
          ).rowCount,
        ).toBe(0);
        const foreign = encodeRecord(
          "projects",
          original.projects.find((p) => p.project.id === "b-private")!,
        ).row;
        await denied(
          client,
          "INSERT INTO app_projects(id,organization_id,project_id,header,payload,baseline_hash) VALUES($1,$2,$1,$3::jsonb,$4::jsonb,$5) ON CONFLICT(id) DO UPDATE SET header=EXCLUDED.header",
          [
            foreign.id,
            "org-b",
            JSON.stringify(foreign.header),
            JSON.stringify(foreign.payload),
            foreign.baselineHash,
          ],
        );
        await denied(
          client,
          "INSERT INTO app_comments(id,organization_id,project_id,user_id,header) VALUES('forged-comment','org-b','b-private','owner-a',$1::jsonb)",
          [
            JSON.stringify({
              id: "forged-comment",
              organizationId: "org-b",
              projectId: "b-private",
              actorId: "owner-a",
              text: "forged",
              createdAt: at,
            }),
          ],
        );
      });
      expect(
        (
          await fixture.admin.query(
            "SELECT header->'project'->>'name' AS name FROM app_projects WHERE id='b-private'",
          )
        ).rows[0].name,
      ).toBe("b-private");
    });

    it("binds indexed identities to JSON and prevents an editor from granting itself ownership", async () => {
      await as({ actor: "owner-a" }, async (client) => {
        for (const sql of [
          "UPDATE app_projects SET organization_id='org-b' WHERE id='a-private'",
          "UPDATE app_projects SET header=jsonb_set(header,'{organizationId}','\"org-b\"') WHERE id='a-private'",
          "UPDATE app_projects SET project_id='b-private' WHERE id='a-private'",
          "UPDATE app_projects SET payload=jsonb_set(payload,'{project,id}','\"b-private\"') WHERE id='a-private'",
          "UPDATE app_comments SET user_id='owner-b' WHERE id='comment-a-private'",
        ])
          await denied(client, sql);
      });
      await as({ actor: "project-editor" }, async (client) => {
        const elevated = {
          version: 2,
          members: [
            {
              userId: "project-editor",
              role: "owner",
              addedAt: at,
              addedBy: "project-editor",
            },
          ],
        };
        await denied(
          client,
          "UPDATE app_projects SET header=jsonb_set(header,'{acl}',$1::jsonb) WHERE id='a-private'",
          [JSON.stringify(elevated)],
        );
        expect(
          (
            await client.query(
              "UPDATE app_memberships SET header=jsonb_set(header,'{role}','\"owner\"') WHERE user_id='project-editor' RETURNING id",
            )
          ).rowCount,
        ).toBe(0);
        expect(
          (
            await client.query(
              "SELECT header->>'role' AS role FROM app_memberships WHERE user_id='project-editor'",
            )
          ).rows[0].role,
        ).toBe("viewer");
      });
      await as({ actor: "project-viewer" }, async (client) => {
        expect(
          (
            await client.query(
              "UPDATE app_projects SET updated_at=now() WHERE id='a-private' RETURNING id",
            )
          ).rowCount,
        ).toBe(0);
      });
    });

    it("allows an editor content save while archiving exactly the new immutable version", async () => {
      await as(
        { actor: "project-editor" },
        async (client) => {
          const update = await client.query(
            "UPDATE app_projects SET header=jsonb_set(jsonb_set(header,'{version}','2'),'{project,name}','\"Allowed edited project\"'),payload=jsonb_set(payload,'{project,name}','\"Allowed edited project\"') WHERE id='a-private' RETURNING id",
          );
          expect(update.rowCount).toBe(1);
          await denied(
            client,
            "SELECT * FROM app_project_versions",
            [],
            ["42501"],
          );
          await denied(
            client,
            "UPDATE app_projects SET payload=jsonb_set(payload,'{project,name}','\"Same-version replacement\"') WHERE id='a-private'",
          );
          await denied(
            client,
            "UPDATE app_project_versions SET payload='{}' WHERE project_id='a-private'",
          );
          await denied(
            client,
            "DELETE FROM app_project_versions WHERE project_id='a-private'",
          );
        },
        web,
        true,
      );
      expect(
        (
          await fixture.admin.query(
            "SELECT version FROM app_project_versions WHERE project_id='a-private' ORDER BY version",
          )
        ).rows.map((row) => Number(row.version)),
      ).toEqual([1, 2]);
      expect(
        (
          await fixture.admin.query(
            "SELECT payload->'project'->>'name' AS name FROM app_project_versions WHERE project_id='a-private' AND version=2",
          )
        ).rows[0].name,
      ).toBe("Allowed edited project");
    });

    it("retains legacy workspace editing and deterministic publication-default materialization", async () => {
      await as({ actor: "member-a" }, async (client) => {
        expect(
          (
            await client.query(
              "UPDATE app_projects SET header=jsonb_set(jsonb_set(header,'{version}','2'),'{project,name}','\"Legacy edit\"'),payload=jsonb_set(payload,'{project,name}','\"Legacy edit\"') WHERE id='a-legacy' RETURNING id",
            )
          ).rowCount,
        ).toBe(1);
      });
      await as({ actor: "owner-a" }, async (client) => {
        const engagement = initialEngagement(undefined, true, at);
        engagement.collection = { status: "closed", version: 2, updatedAt: at };
        expect(
          (
            await client.query(
              "UPDATE app_published SET header=jsonb_set(header,'{engagement}',$1::jsonb) WHERE id='legacy-a' RETURNING id",
              [JSON.stringify(engagement)],
            )
          ).rowCount,
        ).toBe(1);
        expect(
          (
            await client.query(
              "SELECT header->'engagement' AS engagement FROM app_published WHERE id='legacy-a'",
            )
          ).rows[0].engagement,
        ).toEqual(engagement);
      });
    });

    it("requires a matching active public-snapshot capability without exposing private records", async () => {
      await as({ publicSnapshot: "public-a" }, async (client) => {
        expect(await ids(client, "app_published")).toEqual(["public-a"]);
        for (const table of [
          "app_projects",
          "app_comments",
          "app_audit",
          "app_users",
          "app_sessions",
          "app_public_feedback",
        ])
          expect(await ids(client, table)).toEqual([]);
        await denied(
          client,
          "SELECT * FROM app_project_versions",
          [],
          ["42501"],
        );
        const rows = await client.query(
          "SELECT header,payload FROM app_published",
        );
        expect(JSON.stringify(rows.rows)).toContain("Published fixture");
        expect(JSON.stringify(rows.rows)).not.toMatch(
          /private-discussion-marker|secret-password-marker|private-moderation-marker/,
        );
      });
      for (const publicSnapshot of [undefined, "missing", "revoked-a"])
        await as({ publicSnapshot }, async (client) =>
          expect(await ids(client, "app_published")).toEqual([]),
        );
    });

    it("does not reveal private captured geometry or archives through guessed hashes or IDs", async () => {
      const hiddenHash = digest(
        original.projects.find((p) => p.project.id === "b-private")!.baseline,
      );
      await as({ actor: "project-owner" }, async (client) => {
        expect(
          (
            await client.query(
              "SELECT payload FROM app_baseline_snapshots WHERE sha256=$1",
              [hiddenHash],
            )
          ).rows,
        ).toEqual([]);
        await denied(
          client,
          "SELECT payload FROM app_project_versions WHERE project_id='b-private'",
          [],
          ["42501"],
        );
        const accessible = await client.query(
          "SELECT sha256 FROM app_baseline_snapshots",
        );
        expect(accessible.rows.map((row) => row.sha256)).toEqual([
          digest(original.projects[0].baseline),
        ]);
      });
      await as({ publicSnapshot: "public-a" }, async (client) => {
        expect(
          (
            await client.query("SELECT sha256 FROM app_baseline_snapshots")
          ).rows.map((row) => row.sha256),
        ).toEqual([digest(original.projects[0].baseline)]);
        await denied(client, "UPDATE app_baseline_snapshots SET payload='{}'");
        await denied(client, "SELECT app_security_put_baseline($1,$2)", [
          hiddenHash,
          JSON.stringify(place("forged")),
        ]);
      });
    });

    it("separates own responses from team moderation and rejects forged response identity", async () => {
      await as(
        { actor: "participant", publicSnapshot: "public-a" },
        async (client) => {
          expect(await ids(client, "app_public_feedback")).toEqual([
            "feedback-participant",
            "vote-current",
            "vote-old",
          ]);
          const base = await client.query(
            "SELECT header FROM app_public_feedback",
          );
          const safe = await client.query(
            "SELECT app_security_feedback_header(id) AS response FROM app_public_feedback",
          );
          expect(JSON.stringify(base.rows)).not.toContain(
            "private-moderation-marker:",
          );
          expect(JSON.stringify(safe.rows)).not.toContain(
            "private-moderation-marker:",
          );
          expect(
            (
              await client.query(
                "SELECT app_security_feedback_header('feedback-other-participant') AS response",
              )
            ).rows[0].response,
          ).toBeNull();
          await denied(
            client,
            "UPDATE app_public_feedback SET user_id='other-participant' WHERE id='feedback-participant'",
          );
          await denied(
            client,
            "UPDATE app_public_feedback SET header=jsonb_set(header,'{snapshotId}','\"other-public-a\"') WHERE id='feedback-participant'",
          );
          await denied(
            client,
            "UPDATE app_public_feedback SET header=jsonb_set(header,'{moderation,reason}','\"injected\"') WHERE id='feedback-participant'",
          );
          const forged = {
            id: "forged-response",
            snapshotId: "public-a",
            userId: "other-participant",
            kind: "comment",
            text: "forged",
            createdAt: at,
          };
          await denied(
            client,
            "INSERT INTO app_public_feedback(id,snapshot_id,user_id,header) VALUES($1,$2,$3,$4::jsonb)",
            [
              forged.id,
              forged.snapshotId,
              forged.userId,
              JSON.stringify(forged),
            ],
          );
        },
      );
      await as({ actor: "project-owner" }, async (client) => {
        expect(await ids(client, "app_public_feedback")).toEqual([
          "feedback-other-participant",
          "feedback-participant",
          "vote-current",
          "vote-old",
        ]);
        const privateView = await client.query(
          "SELECT app_security_feedback_header(id) AS response FROM app_public_feedback",
        );
        expect(JSON.stringify(privateView.rows)).toContain(
          "private-moderation-marker:",
        );
      });
    });

    it("preserves publication content and cannot be bypassed with DDL, SET ROLE or TRUNCATE", async () => {
      await as({ actor: "owner-a" }, async (client) => {
        await denied(
          client,
          "UPDATE app_published SET payload=jsonb_set(payload,'{scenario,name}','\"Replaced published scenario\"') WHERE id='public-a'",
        );
        await denied(
          client,
          "UPDATE app_published SET header=jsonb_set(header,'{engagement,config,introduction}','\"Replaced frozen survey\"') WHERE id='public-a'",
        );
        for (const sql of [
          `SET ROLE "${fixture.roles.authRole}"`,
          `SET ROLE "${fixture.roles.workerRole}"`,
          `SET ROLE "${fixture.operatorRole.replaceAll('"', '""')}"`,
          `CREATE TABLE "${fixture.schema}".forbidden_table(id text)`,
          "ALTER TABLE app_projects DISABLE ROW LEVEL SECURITY",
          "DROP TABLE app_comments",
          "TRUNCATE app_projects",
          "TRUNCATE app_baseline_snapshots",
        ])
          await denied(client, sql, [], ["42501"]);
        await client.query("SET LOCAL row_security=off");
        await denied(client, "SELECT * FROM app_projects", [], ["42501"]);
      });
    });

    it("rejects fabricated reply and resolver identities and requires real thread-version transitions", async () => {
      const insert =
        "INSERT INTO app_comments(id,organization_id,project_id,user_id,header) VALUES($1,'org-a','a-private','project-commenter',$2::jsonb) RETURNING id";
      await as({ actor: "project-commenter" }, async (client) => {
        const version = Number(
          (
            await client.query(
              "SELECT header->>'version' AS version FROM app_projects WHERE id='a-private'",
            )
          ).rows[0].version,
        );
        const thread = {
          ...structuredClone(original.comments[0]),
          id: "legitimate-thread",
          actorId: "project-commenter",
          author: "project-commenter",
          resolved: false,
          projectVersion: version,
        };
        expect(
          (await client.query(insert, [thread.id, JSON.stringify(thread)]))
            .rowCount,
        ).toBe(1);
        for (const patch of [
          {
            replies: [
              {
                id: "forged-reply",
                actorId: "owner-b",
                author: "owner-b",
                text: "Forged reply",
                createdAt: at,
                scenarioRevision: 0,
              },
            ],
          },
          { resolved: true, resolvedBy: "owner-b", resolvedAt: at },
        ]) {
          const forged = { ...thread, ...patch, id: "forged-thread" };
          await denied(client, insert, [forged.id, JSON.stringify(forged)]);
        }
        await denied(
          client,
          "UPDATE app_comments SET header=jsonb_set(jsonb_set(jsonb_set(header,'{threadVersion}','2'),'{resolvedBy}','\"project-commenter\"'),'{resolvedAt}','\"2026-11-06T00:00:00Z\"') WHERE id='resolved-a-private'",
        );
      });
      await as({ actor: "owner-a" }, async (client) => {
        const reply = [
          {
            id: "new-reply",
            actorId: "owner-a",
            author: "owner-a",
            text: "Legitimate author, missing required history version",
            createdAt: at,
            scenarioRevision: 0,
          },
        ];
        await denied(
          client,
          "UPDATE app_comments SET header=jsonb_set(header-'threadVersion','{replies}',$1::jsonb) WHERE id='comment-a-private'",
          [JSON.stringify(reply)],
        );
        await denied(
          client,
          "UPDATE app_comments SET header=jsonb_set(jsonb_set(header,'{threadVersion}','2'),'{resolvedBy}','\"owner-b\"') WHERE id='resolved-a-private'",
        );
        await denied(
          client,
          "UPDATE app_comments SET header=jsonb_set(jsonb_set(jsonb_set(header,'{threadVersion}','2'),'{resolved}','null'),'{resolvedBy}','\"owner-b\"') WHERE id='resolved-a-private'",
        );
        await denied(
          client,
          "UPDATE app_comments SET header=jsonb_set(jsonb_set(header-'resolved','{threadVersion}','2'),'{resolvedBy}','\"owner-b\"') WHERE id='resolved-a-private'",
        );
      });
    });

    it("refuses feedback inserts when collection is closed or that response kind is disabled", async () => {
      for (const snapshotId of ["closed-a", "disabled-a"])
        await as(
          { actor: "participant", publicSnapshot: snapshotId },
          async (client) => {
            const record = {
              id: "forbidden-response",
              snapshotId,
              userId: "participant",
              kind: "comment",
              text: "Valid account, unavailable collection",
              createdAt: at,
              moderation: { status: "pending", version: 1 },
            };
            await denied(
              client,
              "INSERT INTO app_public_feedback(id,snapshot_id,user_id,header) VALUES($1,$2,$3,$4::jsonb)",
              [record.id, snapshotId, record.userId, JSON.stringify(record)],
            );
          },
        );
    });

    it("requires owner moderation to advance its version and retain a nonempty review reason", async () => {
      await as({ actor: "project-owner" }, async (client) => {
        for (const moderation of [
          {
            status: "excluded",
            version: 1,
            reason: "Stale version",
            updatedAt: at,
          },
          {
            status: "excluded",
            version: 0,
            reason: "Invalid version",
            updatedAt: at,
          },
          { status: "excluded", reason: "Missing version", updatedAt: at },
          { status: "excluded", version: 2, reason: "   ", updatedAt: at },
        ])
          await denied(
            client,
            "UPDATE app_public_feedback SET header=jsonb_set(header,'{moderation}',$1::jsonb) WHERE id='feedback-participant'",
            [JSON.stringify(moderation)],
          );
        expect(
          (
            await client.query(
              "UPDATE app_public_feedback SET header=jsonb_set(header,'{moderation}',$1::jsonb) WHERE id='feedback-participant' RETURNING id",
              [
                JSON.stringify({
                  status: "excluded",
                  version: 2,
                  reason: "Duplicate response reviewed",
                  updatedAt: at,
                }),
              ],
            )
          ).rowCount,
        ).toBe(1);
        expect(
          (
            await client.query(
              "SELECT app_security_feedback_header('feedback-participant') AS response",
            )
          ).rows[0].response.moderation,
        ).toMatchObject({
          status: "excluded",
          version: 2,
          reason: "Duplicate response reviewed",
        });
      });
    });

    it("keeps supersession history append-only and requires a same-account replacement", async () => {
      await as(
        { actor: "participant", publicSnapshot: "public-a" },
        async (client) => {
          await denied(
            client,
            "UPDATE app_public_feedback SET header=header-'supersededAt' WHERE id='vote-old'",
            [],
            ["42501", "23514", "55000"],
            true,
          );
          await denied(
            client,
            "UPDATE app_public_feedback SET header=jsonb_set(header,'{supersededAt}','\"2026-11-06T00:00:00Z\"') WHERE id='vote-current'",
            [],
            ["42501", "23514", "55000"],
            true,
          );
          expect(
            (
              await client.query(
                "DELETE FROM app_public_feedback WHERE id='vote-current' RETURNING id",
              )
            ).rowCount,
          ).toBe(0);
          const replacement = {
            id: "vote-replacement",
            snapshotId: "public-a",
            userId: "participant",
            kind: "vote",
            vote: "neutral",
            createdAt: "2026-11-06T00:00:00Z",
            moderation: { status: "pending", version: 1 },
          };
          await client.query(
            "UPDATE app_public_feedback SET header=jsonb_set(header,'{supersededAt}','\"2026-11-06T00:00:00Z\"') WHERE id='vote-current'",
          );
          await client.query(
            "INSERT INTO app_public_feedback(id,snapshot_id,user_id,header) VALUES($1,$2,$3,$4::jsonb)",
            [
              replacement.id,
              replacement.snapshotId,
              replacement.userId,
              JSON.stringify(replacement),
            ],
          );
          await client.query("SET CONSTRAINTS ALL IMMEDIATE");
          expect(
            (
              await client.query(
                "SELECT id FROM app_public_feedback WHERE header->>'kind'='vote' AND NOT header ? 'supersededAt'",
              )
            ).rows.map((row) => row.id),
          ).toEqual(["vote-replacement"]);
        },
      );
      await as({ actor: "project-owner" }, async (client) => {
        await denied(
          client,
          "UPDATE app_public_feedback SET header=header-'supersededAt' WHERE id='vote-old'",
          [],
          ["42501", "23514", "55000"],
          true,
        );
        await denied(
          client,
          "UPDATE app_public_feedback SET header=jsonb_set(header,'{supersededAt}','\"2026-11-01T00:00:00Z\"') WHERE id='vote-current'",
          [],
          ["42501", "23514", "55000"],
          true,
        );
      });
    });

    it("clears transaction-local credentials on commit, rollback and error before reusing one connection", async () => {
      const client = await web.connect();
      const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0]
        .pid;
      try {
        for (const ending of ["COMMIT", "ROLLBACK", "ERROR"] as const) {
          await client.query("BEGIN");
          await setContext(client, {
            actor: "owner-a",
            publicSnapshot: "public-a",
          });
          expect(await ids(client, "app_projects")).toEqual([
            "a-legacy",
            "a-private",
            "a-sibling",
          ]);
          if (ending === "ERROR") {
            await expect(client.query("SELECT 1/0")).rejects.toMatchObject({
              code: "22012",
            });
            await client.query("ROLLBACK");
          } else await client.query(ending);
          expect(await ids(client, "app_projects")).toEqual([]);
          expect(await ids(client, "app_published")).toEqual([]);
          expect(
            (
              await client.query(
                "SELECT current_setting('urban.session_hash',true) AS credential",
              )
            ).rows[0].credential ?? "",
          ).toBe("");
        }
      } finally {
        client.release();
      }
      await as({ actor: "owner-b" }, async (reused) => {
        expect(
          (await reused.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
        ).toBe(pid);
        expect(await ids(reused, "app_projects")).toEqual(["b-private"]);
      });
    });

    it("rejects logged-out credentials and revoked project grants on the next transaction", async () => {
      await as({ actor: "logout" }, async (client) =>
        expect(await ids(client, "app_projects")).toHaveLength(3),
      );
      await fixture.admin.query("DELETE FROM app_sessions WHERE id=$1", [
        session("logout"),
      ]);
      await as({ actor: "logout" }, async (client) =>
        expect(await ids(client, "app_projects")).toEqual([]),
      );
      await as({ actor: "revoked-viewer" }, async (client) =>
        expect(await ids(client, "app_projects")).toEqual(["a-private"]),
      );
      const record = structuredClone(original.projects[0]);
      record.acl!.members = record.acl!.members.filter(
        (grant) => grant.userId !== "revoked-viewer",
      );
      record.acl!.version++;
      await fixture.admin.query(
        "UPDATE app_projects SET header=jsonb_set(header,'{acl}',$1::jsonb) WHERE id='a-private'",
        [JSON.stringify(record.acl)],
      );
      await as({ actor: "revoked-viewer" }, async (client) =>
        expect(await ids(client, "app_projects")).toEqual([]),
      );
    });

    it("binds privileged audit events to actual roles or same-transaction owner transitions and submitted feedback", async () => {
      const insertAudit =
        "INSERT INTO app_audit(id,organization_id,project_id,snapshot_id,header) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id";
      const event = (
        id: string,
        actorId: string,
        action: string,
        details: Record<string, unknown> = {},
      ) => ({
        id,
        organizationId: "org-a",
        projectId: "a-private",
        actorId,
        action,
        at,
        details,
      });
      const parameters = (record: ReturnType<typeof event>) => [
        record.id,
        record.organizationId,
        record.projectId,
        record.details.snapshotId ?? null,
        JSON.stringify(record),
      ];

      await as({ actor: "project-viewer" }, async (client) => {
        for (const action of ["project.member.updated", "project.deleted"])
          await denied(
            client,
            insertAudit,
            parameters(
              event("forged-privileged-audit", "project-viewer", action, {
                userId: "project-viewer",
                role: "owner",
              }),
            ),
          );
      });

      await as(
        { actor: "project-owner" },
        async (client) => {
          const acl = (
            await client.query(
              "SELECT header->'acl' AS acl FROM app_projects WHERE id='a-private'",
            )
          ).rows[0].acl as {
            version: number;
            members: { userId: string; role: string }[];
          };
          acl.version++;
          acl.members = acl.members.map((grant) =>
            grant.userId === "project-owner"
              ? { ...grant, role: "viewer" }
              : grant,
          );
          expect(
            (
              await client.query(
                "UPDATE app_projects SET header=jsonb_set(header,'{acl}',$1::jsonb) WHERE id='a-private' RETURNING id",
                [JSON.stringify(acl)],
              )
            ).rowCount,
          ).toBe(1);
          const audit = event(
            "legitimate-self-downgrade-audit",
            "project-owner",
            "project.member.updated",
            {
              userId: "project-owner",
              role: "viewer",
              aclVersion: acl.version,
            },
          );
          expect(
            (await client.query(insertAudit, parameters(audit))).rowCount,
          ).toBe(1);
          await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        },
        web,
        true,
      );
      expect(
        (
          await fixture.admin.query(
            "SELECT header->>'actorId' AS actor FROM app_audit WHERE id='legitimate-self-downgrade-audit'",
          )
        ).rows[0].actor,
      ).toBe("project-owner");

      await as({ actor: "project-owner" }, async (client) => {
        const forged = event(
          "stale-owner-proof-audit",
          "project-owner",
          "project.member.updated",
          { userId: "project-owner", role: "owner" },
        );
        await denied(client, insertAudit, parameters(forged));
        for (const [key, value] of Object.entries({
          "urban.project_id": "a-private",
          "urban.audit_role": "owner",
          "urban.prechange_owner": "true",
          "urban.project_write_proof": JSON.stringify({
            projectId: "a-private",
            userId: "project-owner",
            role: "owner",
          }),
        }))
          await client.query("SELECT set_config($1,$2,true)", [key, value]);
        await denied(client, insertAudit, parameters(forged));
        await denied(
          client,
          "SELECT * FROM app_project_write_proofs",
          [],
          ["42501"],
        );
      });

      await as(
        { actor: "participant", publicSnapshot: "public-a" },
        async (client) => {
          // Participants may append a matching submission audit but cannot read
          // private project audit rows; RETURNING would require that extra access.
          const appendAudit = insertAudit.replace(" RETURNING id", "");
          const mismatchedActor = event(
            "forged-feedback-actor-audit",
            "participant",
            "engagement.submitted",
            {
              snapshotId: "public-a",
              feedbackId: "feedback-other-participant",
              kind: "comment",
            },
          );
          await denied(
            client,
            appendAudit,
            parameters(mismatchedActor),
            ["42501", "23514"],
            true,
          );
          const mismatchedOrg = {
            ...event(
              "forged-feedback-org-audit",
              "participant",
              "engagement.submitted",
              {
                snapshotId: "public-a",
                feedbackId: "feedback-participant",
                kind: "comment",
              },
            ),
            organizationId: "org-b",
          };
          await denied(
            client,
            appendAudit,
            parameters(mismatchedOrg),
            ["42501", "23514"],
            true,
          );
          const response = {
            id: "audited-new-response",
            snapshotId: "public-a",
            userId: "participant",
            kind: "comment",
            text: "Legitimate response with a matching audit",
            createdAt: at,
            moderation: { status: "pending", version: 1 },
          };
          await client.query(
            "INSERT INTO app_public_feedback(id,snapshot_id,user_id,header) VALUES($1,$2,$3,$4::jsonb)",
            [
              response.id,
              response.snapshotId,
              response.userId,
              JSON.stringify(response),
            ],
          );
          const audit = event(
            "legitimate-feedback-audit",
            "participant",
            "engagement.submitted",
            {
              snapshotId: "public-a",
              feedbackId: response.id,
              kind: "comment",
            },
          );
          expect(
            (await client.query(appendAudit, parameters(audit))).rowCount,
          ).toBe(1);
          await client.query("SET CONSTRAINTS ALL IMMEDIATE");
        },
      );
    });
  },
);

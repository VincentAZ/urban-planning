import { reviewBudgetForFixture } from "./budget-test-fixture.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Place } from "@urban/core";
import { createProject, calculateImpact } from "@urban/models";
import { PostgresStore } from "./postgres-store.js";
import { emptyState, type DataState } from "./store.js";
import { stateFingerprint, type ScopeReader } from "./storage-core.js";
import {
  BudgetService,
  budgetDashboard,
  updateBudgetPolicy,
} from "./budget.js";

const connection = process.env.TEST_DATABASE_URL;
const fixtureTime = "2026-11-05T00:00:00.000Z";
const place: Place = {
  id: "storage-fixture",
  name: "Captured place",
  city: "Phoenix",
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
  loadedAt: fixtureTime,
  extentLabel: "Stored fixture extent",
};
function legacyFixture(): DataState {
  const state = emptyState();
  state.users.push({
    id: "owner",
    email: "owner@example.test",
    name: "Owner",
    passwordHash: "fixture-hash",
    createdAt: fixtureTime,
  });
  state.organizations.push({
    id: "workspace",
    name: "Original workspace",
    createdAt: fixtureTime,
  });
  state.memberships.push({
    userId: "owner",
    organizationId: "workspace",
    role: "owner",
  });
  state.sessions.push({
    hash: "fixture-session",
    csrfToken: "fixture-csrf",
    userId: "owner",
    organizationId: "workspace",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  for (const id of ["first", "second"]) {
    const project = createProject(place);
    project.id = id;
    project.name = `Saved ${id}`;
    state.projects.push({
      organizationId: "workspace",
      project,
      version: 1,
      baseline: structuredClone(place),
      createdBy: "owner",
      createdAt: fixtureTime,
    });
  }
  const scenario = state.projects[0].project.scenarios[1];
  state.published.push({
    id: "snapshot",
    organizationId: "workspace",
    projectId: "first",
    projectName: "Saved first",
    placeId: place.id,
    baseline: structuredClone(place),
    scenario,
    results: calculateImpact(place, scenario),
    createdAt: fixtureTime,
    feedbackEnabled: true,
  });
  state.comments.push({
    id: "thread",
    projectId: "first",
    organizationId: "workspace",
    actorId: "owner",
    author: "Owner",
    text: "Retain this private thread",
    scenarioId: scenario.id,
    createdAt: fixtureTime,
    scenarioRevision: 0,
    threadVersion: 1,
    replies: [],
  });
  state.audit.push({
    id: "audit",
    organizationId: "workspace",
    projectId: "first",
    actorId: "owner",
    action: "snapshot-created",
    at: fixtureTime,
    details: { snapshotId: "snapshot" },
  });
  // Deliberately reverse lexical ID order and tie timestamps; insertion order determines the latest response.
  state.publicFeedback.push(
    {
      id: "z-first",
      snapshotId: "snapshot",
      userId: "owner",
      kind: "vote",
      vote: "support",
      createdAt: fixtureTime,
    },
    {
      id: "a-last",
      snapshotId: "snapshot",
      userId: "owner",
      kind: "vote",
      vote: "concern",
      createdAt: fixtureTime,
    },
  );
  return state;
}
function scopedConnection(schema: string) {
  const url = new URL(connection!);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
}
describe.skipIf(!connection)("PostGIS persistence integration", () => {
  const schema = `urban_test_${randomUUID().replace(/-/g, "")}`;
  let pool: pg.Pool;
  let store: PostgresStore;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: connection });
    await pool.query(`CREATE SCHEMA ${schema}`);
    // All test tables live in a uniquely named schema, never in the application schema.
    const url = new URL(connection!);
    url.searchParams.set("options", `-c search_path=${schema},public`);
    store = new PostgresStore(url.toString(), { mode: "operator" });
    await store.migrate();
  });
  afterAll(async () => {
    await store?.close();
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.end();
    }
  });
  it("applies its migration idempotently and has functional spatial operations", async () => {
    await store.migrate();
    expect((await store.read((state) => state)).schemaVersion).toBe(1);
    const geometry = await pool.query(
      "SELECT ST_AsText(ST_SetSRID(ST_MakePoint(-112.07, 33.45), 4326)) AS point",
    );
    expect(geometry.rows[0].point).toBe("POINT(-112.07 33.45)");
  });
  it("serializes concurrent writes without losing updates", async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.transaction((state) => {
          state.organizations.push({
            id: `org-${index}`,
            name: `Workspace ${index}`,
            createdAt: new Date().toISOString(),
          });
        }),
      ),
    );
    expect(await store.read((state) => state.organizations.length)).toBe(12);
  });
  it("rolls back a failed transaction and survives a connection restart", async () => {
    await expect(
      store.transaction((state) => {
        state.organizations = [];
        throw new Error("Simulated failure");
      }),
    ).rejects.toThrow("Simulated failure");
    expect(await store.read((state) => state.organizations.length)).toBe(12);
    await store.close();
    const url = new URL(connection!);
    url.searchParams.set("options", `-c search_path=${schema},public`);
    store = new PostgresStore(url.toString(), { mode: "operator" });
    expect(await store.read((state) => state.organizations.length)).toBe(12);
  });
  it("admits costs atomically across independent database connections", async () => {
    await store.transaction((state) =>
      updateBudgetPolicy(
        state.budget,
        {
          expectedVersion: 1,
          monthlyLimitCents: 1_000,
          safetyMarginCents: 100,
          fixedCostReserveCents: 0,
          paidOperationsPaused: false,
        },
        "admin",
      ),
    );
    const url = new URL(connection!);
    url.searchParams.set("options", `-c search_path=${schema},public`);
    await store.transaction((s) => reviewBudgetForFixture(s.budget));
    const second = new PostgresStore(url.toString(), { mode: "operator" });
    try {
      const services = [new BudgetService(store), new BudgetService(second)];
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, (_, i) =>
          services[i % 2].reserve({
            idempotencyKey: `postgres-budget-job-${i}`,
            provider: "test",
            operation: "atomic-admission",
            actorId: "worker",
            maximumCents: 300,
          }),
        ),
      );
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(3);
      expect(
        (await store.read((state) => budgetDashboard(state.budget))).totals,
      ).toMatchObject({ reservedCents: 900, availableCents: 0 });
    } finally {
      await second.close();
    }
  });
});

describe.skipIf(!connection)(
  "Scoped PostgreSQL migration and integrity",
  () => {
    const schema = `urban_scoped_${randomUUID().replace(/-/g, "")}`;
    const original = legacyFixture();
    let admin: pg.Pool;
    let database: pg.Pool;
    let store: PostgresStore;
    beforeAll(async () => {
      admin = new pg.Pool({ connectionString: connection });
      await admin.query(`CREATE SCHEMA ${schema}`);
      database = new pg.Pool({ connectionString: scopedConnection(schema) });
      await database.query(
        await readFile(
          new URL("../migrations/001-foundation.sql", import.meta.url),
          "utf8",
        ),
      );
      await database.query(
        "INSERT INTO app_state(id,document) VALUES(1,$1::jsonb)",
        [JSON.stringify(original)],
      );
      store = new PostgresStore(scopedConnection(schema), { mode: "operator" });
      await store.migrate();
    });
    afterAll(async () => {
      await store?.close();
      await database?.end();
      if (admin) {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await admin.end();
      }
    });
    it("atomically preserves every legacy record and response order while deduplicating captured baselines", async () => {
      const restored = await store.read((state) => state);
      expect(stateFingerprint(restored)).toBe(stateFingerprint(original));
      expect(restored.publicFeedback.map((response) => response.id)).toEqual([
        "z-first",
        "a-last",
      ]);
      const manifest = (
        await database.query("SELECT * FROM app_storage_manifest")
      ).rows[0];
      expect(manifest.legacy_fingerprint).toBe(manifest.verified_fingerprint);
      expect(manifest.verified_fingerprint).toBe(stateFingerprint(original));
      expect(manifest.baseline_count).toBe(1);
      expect(manifest.entity_counts).toMatchObject({
        projects: 2,
        published: 1,
        publicFeedback: 2,
        comments: 1,
        budget: 1,
        preparationControl: 1,
      });
      expect(
        (await database.query("SELECT count(*) FROM app_baseline_snapshots"))
          .rows[0].count,
      ).toBe("1");
      expect(
        (await database.query("SELECT count(*) FROM app_project_versions"))
          .rows[0].count,
      ).toBe("2");
      expect(
        (await database.query("SELECT document FROM app_state WHERE id=1"))
          .rows[0].document,
      ).toEqual(original);
    });
    it("can rerun the migration, preserves the old document, and rejects obsolete writers", async () => {
      await store.migrate();
      for (const sql of [
        "UPDATE app_state SET document='{}'::jsonb WHERE id=1",
        "DELETE FROM app_state WHERE id=1",
        "INSERT INTO app_state(id,document) VALUES(1,'{}'::jsonb) ON CONFLICT(id) DO UPDATE SET document=EXCLUDED.document",
        "TRUNCATE app_state",
      ])
        await expect(database.query(sql)).rejects.toMatchObject({
          code: "55000",
        });
      expect(
        (await database.query("SELECT document FROM app_state WHERE id=1"))
          .rows[0].document,
      ).toEqual(original);
      expect(
        (
          await database.query(
            "SELECT count(*) FROM app_schema_migrations WHERE version=2",
          )
        ).rows[0].count,
      ).toBe("1");
    });
    it("loads authorized metadata without scenario payloads or geographic blobs, and patches ACLs without revising content", async () => {
      store.diagnostics(true);
      const headers = await store.read(
        (state) => {
          expect(state.users.map((user) => user.id)).toEqual(["owner"]);
          expect(state.memberships).toHaveLength(1);
          expect(() => state.projects).toThrow("not selected");
          return state.projectHeaders;
        },
        {
          auth: { sessionHash: "fixture-session" },
          projectHeaders: {
            where: [{ organizationId: { auth: "organizationId" } }],
          },
        },
      );
      expect(headers.map((header) => header.project.id)).toEqual([
        "first",
        "second",
      ]);
      expect(headers[0]).not.toHaveProperty("baseline");
      expect(headers[0].project.scenarios[0]).not.toHaveProperty("assumptions");
      expect(store.diagnostics()).toMatchObject({
        baselineLoads: 0,
        baselineBytes: 0,
        payloadBytes: 0,
      });
      const before = (
        await database.query(
          "SELECT payload,baseline_hash FROM app_projects WHERE id='first'",
        )
      ).rows[0];
      store.diagnostics(true);
      await store.transaction(
        (state) => {
          state.projectHeaders[0].acl = {
            version: 1,
            members: [
              {
                userId: "owner",
                role: "owner",
                addedAt: fixtureTime,
                addedBy: "owner",
              },
            ],
          };
        },
        { projectHeaders: { where: [{ id: "first" }] } },
      );
      expect(store.diagnostics()).toMatchObject({
        baselineLoads: 0,
        payloadBytes: 0,
      });
      expect(
        (
          await database.query(
            "SELECT payload,baseline_hash FROM app_projects WHERE id='first'",
          )
        ).rows[0],
      ).toEqual(before);
      expect(
        (
          await database.query(
            "SELECT count(*) FROM app_project_versions WHERE project_id='first'",
          )
        ).rows[0].count,
      ).toBe("1");
      await expect(
        store.transaction(
          (state) => {
            state.projectHeaders[0].project.name = "Illegal projected edit";
          },
          { projectHeaders: { where: [{ id: "first" }] } },
        ),
      ).rejects.toThrow("Immutable projectHeaders");
    });
    it("treats empty selectors as no matches and confines deletions and inserts to their selected identities", async () => {
      for (const where of [[], [{}], [{ id: [] }], [{ id: ["missing"] }]])
        expect(
          await store.read((state) => state.projects, { projects: { where } }),
        ).toEqual([]);
      await expect(
        store.transaction(
          (state) => {
            state.organizations.push({
              id: "workspace",
              name: "Takeover",
              createdAt: fixtureTime,
            });
          },
          { organizations: { append: true } },
        ),
      ).rejects.toThrow("already exists outside");
      await store.transaction(
        (state) => {
          state.organizations.push({
            id: "temporary",
            name: "Temporary",
            createdAt: fixtureTime,
          });
        },
        { organizations: { append: true } },
      );
      await store.transaction(
        (state) => {
          state.organizations = [];
        },
        { organizations: { where: [{ id: "temporary" }] } },
      );
      expect(
        await store.read((state) => state.organizations.map((org) => org.id), {
          organizations: { all: true },
        }),
      ).toEqual(["workspace"]);
    });
    it("archives each content version immutably and refuses content replacement without a version increment", async () => {
      const scope = { projects: { where: [{ id: "second" }] } };
      await store.transaction((state) => {
        state.projects[0].version++;
        state.projects[0].project.name = "Revised second";
      }, scope);
      const versions = (
        await database.query(
          "SELECT version,payload FROM app_project_versions WHERE project_id='second' ORDER BY version",
        )
      ).rows;
      expect(versions.map((row) => row.version)).toEqual(["1", "2"]);
      expect(versions.map((row) => row.payload.project.name)).toEqual([
        "Saved second",
        "Revised second",
      ]);
      await expect(
        store.transaction((state) => {
          state.projects[0].project.name = "Silent replacement";
        }, scope),
      ).rejects.toThrow("cannot be silently replaced");
      expect(
        await store.read((state) => state.projects[0].project.name, scope),
      ).toBe("Revised second");
      await expect(
        database.query(
          "UPDATE app_project_versions SET payload='{}'::jsonb WHERE project_id='second'",
        ),
      ).rejects.toMatchObject({ code: "55000" });
      await expect(
        database.query("DELETE FROM app_baseline_snapshots"),
      ).rejects.toMatchObject({ code: "55000" });
    });
    it("retains project history as a tombstone so deleting and recreating an ID cannot reconnect private records", async () => {
      const record = await store.read((state) => state.projects[0], {
        projects: { where: [{ id: "second" }] },
      });
      await store.transaction(
        (state) => {
          state.projects = [];
        },
        { projects: { where: [{ id: "second" }] } },
      );
      await expect(
        store.transaction(
          (state) => {
            state.projects.push(record);
          },
          { projects: { append: true } },
        ),
      ).rejects.toThrow("retired project identity");
      expect(
        (
          await database.query(
            "SELECT count(*) FROM app_project_versions WHERE project_id='second'",
          )
        ).rows[0].count,
      ).toBe("2");
      expect(
        await store.read(
          (state) => state.projects.map((entry) => entry.project.id),
          { projects: { all: true } },
        ),
      ).toEqual(["first"]);
    });
    it("captures authorization and content from one repeatable-read snapshot during a concurrent update", async () => {
      const second = new PostgresStore(scopedConnection(schema), {
        mode: "operator",
      });
      const internals = store as unknown as {
        reader(client: pg.PoolClient): ScopeReader;
      };
      const originalReader = internals.reader.bind(store);
      let changed = false;
      const spy = vi.spyOn(internals, "reader").mockImplementation((client) => {
        const reader = originalReader(client);
        return {
          ...reader,
          query: async (...args) => {
            const rows = await reader.query(...args);
            if (!changed) {
              changed = true;
              await second.transaction(
                (state) => {
                  state.organizations[0].name = "Concurrent workspace";
                  state.projects[0].project.name = "Concurrent project";
                  state.projects[0].version++;
                },
                {
                  organizations: { where: [{ id: "workspace" }] },
                  projects: { where: [{ id: "first" }] },
                },
              );
            }
            return rows;
          },
        };
      });
      try {
        const capture = await store.read(
          (state) => ({
            organization: state.organizations[0].name,
            project: state.projects[0].project.name,
          }),
          {
            auth: { sessionHash: "fixture-session" },
            projects: {
              where: [
                { id: "first", organizationId: { auth: "organizationId" } },
              ],
            },
          },
        );
        expect(capture).toEqual({
          organization: "Original workspace",
          project: "Saved first",
        });
      } finally {
        spy.mockRestore();
        await second.close();
      }
      expect(
        await store.read((state) => state.projects[0].project.name, {
          projects: { where: [{ id: "first" }] },
        }),
      ).toBe("Concurrent project");
    });
    it("rejects asynchronous mutation callbacks without persisting any changes", async () => {
      await expect(
        store.transaction(
          async (state) => {
            state.organizations[0].name = "Async mutation";
          },
          { organizations: { where: [{ id: "workspace" }] } },
        ),
      ).rejects.toThrow("synchronous");
      expect(
        await store.read((state) => state.organizations[0].name, {
          organizations: { where: [{ id: "workspace" }] },
        }),
      ).toBe("Concurrent workspace");
    });
    it("detects corrupted geographic content without making header-only operations hydrate it", async () => {
      const originalBlob = (
        await database.query(
          "SELECT sha256,payload FROM app_baseline_snapshots",
        )
      ).rows[0];
      // Deliberate corruption is confined to this disposable schema and requires
      // bypassing the immutable trigger; normal application writes cannot do this.
      await database.query(
        "ALTER TABLE app_baseline_snapshots DISABLE TRIGGER app_baseline_immutable",
      );
      try {
        await database.query(
          "UPDATE app_baseline_snapshots SET payload=jsonb_set(payload,'{name}','\"Corrupted place\"'::jsonb)",
        );
        store.diagnostics(true);
        expect(
          await store.read((state) => state.projectHeaders[0].project.id, {
            projectHeaders: { where: [{ id: "first" }] },
          }),
        ).toBe("first");
        expect(store.diagnostics()).toMatchObject({
          baselineLoads: 0,
          payloadBytes: 0,
        });
        await expect(
          store.read((state) => state.projects[0], {
            projects: { where: [{ id: "first" }] },
          }),
        ).rejects.toThrow("integrity check");
      } finally {
        await database.query(
          "UPDATE app_baseline_snapshots SET payload=$1::jsonb WHERE sha256=$2",
          [JSON.stringify(originalBlob.payload), originalBlob.sha256],
        );
        await database.query(
          "ALTER TABLE app_baseline_snapshots ENABLE TRIGGER app_baseline_immutable",
        );
      }
      expect(
        await store.read((state) => state.projects[0].baseline.name, {
          projects: { where: [{ id: "first" }] },
        }),
      ).toBe("Captured place");
      await expect(
        database.query("TRUNCATE app_project_versions"),
      ).rejects.toMatchObject({ code: "55000" });
    });
    it("rolls a failed migration back completely and allows an explicit corrected retry", async () => {
      const failedSchema = `urban_failed_${randomUUID().replace(/-/g, "")}`;
      await admin.query(`CREATE SCHEMA ${failedSchema}`);
      const isolated = new pg.Pool({
        connectionString: scopedConnection(failedSchema),
      });
      const failing = new PostgresStore(scopedConnection(failedSchema), {
        mode: "operator",
      });
      const invalid = legacyFixture();
      invalid.projects.push(structuredClone(invalid.projects[0]));
      try {
        await isolated.query(
          await readFile(
            new URL("../migrations/001-foundation.sql", import.meta.url),
            "utf8",
          ),
        );
        await isolated.query(
          "INSERT INTO app_state(id,document) VALUES(1,$1::jsonb)",
          [JSON.stringify(invalid)],
        );
        await expect(failing.migrate()).rejects.toThrow("Duplicate");
        expect(
          (await isolated.query("SELECT document FROM app_state WHERE id=1"))
            .rows[0].document,
        ).toEqual(invalid);
        expect(
          (
            await isolated.query("SELECT to_regclass($1) AS table_name", [
              `${failedSchema}.app_storage_manifest`,
            ])
          ).rows[0].table_name,
        ).toBeNull();
        await isolated.query(
          "UPDATE app_state SET document=$1::jsonb WHERE id=1",
          [JSON.stringify(original)],
        );
        await failing.migrate();
        expect(stateFingerprint(await failing.read((state) => state))).toBe(
          stateFingerprint(original),
        );
      } finally {
        await failing.close();
        await isolated.end();
        await admin.query(`DROP SCHEMA IF EXISTS ${failedSchema} CASCADE`);
      }
    });
  },
);

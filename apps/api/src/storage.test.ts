import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baselineIdentity, type Place } from "@urban/core";
import { calculateImpact, createProject } from "@urban/models";
import { emptyState, FileStore, type DataState } from "./store.js";
import { readPersistedState } from "./file-store.js";
import { stateFingerprint } from "./storage-core.js";
import { initialProjectAcl } from "./project-access.js";
import { initialEngagement } from "./engagement.js";

const place: Place = {
  id: "storage-fixture",
  name: "Captured source",
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
  loadedAt: "2026-11-05T00:00:00Z",
  extentLabel: "Storage fixture only",
};
const at = "2026-11-05T00:00:00Z";
function fixture(): DataState {
  const state = emptyState();
  for (const n of [1, 2]) {
    state.users.push({
      id: `u${n}`,
      email: `u${n}@example.test`,
      name: `Account ${n}`,
      passwordHash: "fixture",
      createdAt: at,
    });
    state.organizations.push({
      id: `o${n}`,
      name: `Workspace ${n}`,
      createdAt: at,
    });
    state.memberships.push({
      userId: `u${n}`,
      organizationId: `o${n}`,
      role: "owner",
    });
    state.sessions.push({
      hash: `s${n}`,
      userId: `u${n}`,
      organizationId: `o${n}`,
      csrfToken: `csrf${n}`,
      expiresAt: "2099-01-01T00:00:00Z",
    });
    const project = createProject(place);
    project.id = `p${n}`;
    state.projects.push({
      project,
      organizationId: `o${n}`,
      version: 1,
      baseline: structuredClone(place),
      createdBy: `u${n}`,
      createdAt: at,
      ...(n === 2 ? { acl: initialProjectAcl(`u${n}`, at) } : {}),
    });
  }
  const scenario = state.projects[0].project.scenarios[0];
  state.published.push({
    id: "snapshot",
    organizationId: "o1",
    projectId: "p1",
    projectName: "Proposal",
    placeId: place.id,
    baseline: structuredClone(place),
    scenario,
    results: calculateImpact(place, scenario),
    createdAt: at,
    feedbackEnabled: true,
  });
  // Deliberately unordered IDs and tied timestamps: historical insertion order is meaningful.
  state.publicFeedback.push(
    {
      id: "z-first",
      snapshotId: "snapshot",
      userId: "u1",
      kind: "vote",
      vote: "support",
      createdAt: at,
    },
    {
      id: "a-second",
      snapshotId: "snapshot",
      userId: "u1",
      kind: "vote",
      vote: "concern",
      createdAt: at,
    },
  );
  return state;
}
const stores: FileStore[] = [],
  directories: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function migrated() {
  const directory = await mkdtemp(join(tmpdir(), "urban-scoped-storage-"));
  directories.push(directory);
  const filename = join(directory, "state.json"),
    state = fixture(),
    original = JSON.stringify(state);
  await writeFile(filename, original, { mode: 0o600 });
  const store = new FileStore(filename);
  stores.push(store);
  await store.read((s) => s.schemaVersion, {});
  return { filename, store, state, original };
}

describe("scoped transactional storage and migration", () => {
  it("redacts malformed legacy JSON parser details while preserving the original bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "urban-invalid-legacy-"));
    directories.push(directory);
    const filename = join(directory, "state.json");
    const original =
      '{"privateValue":"DO-NOT-LOG-THIS" trailing invalid content';
    await writeFile(filename, original);
    const store = new FileStore(filename);
    stores.push(store);
    const error = await store
      .read((s) => s.schemaVersion)
      .catch((reason: Error) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Legacy database JSON is invalid; original data is unchanged.",
    );
    expect((error as Error).stack).not.toContain("DO-NOT-LOG-THIS");
    expect((error as Error).cause).toBeUndefined();
    expect(await readFile(filename, "utf8")).toBe(original);
  });

  it("verifies complete legacy migration, deduplicates baselines and preserves original bytes/order across restart", async () => {
    const { filename, store, state, original } = await migrated();
    expect(stateFingerprint(await store.read((s) => s))).toBe(
      stateFingerprint(state),
    );
    const database = new DatabaseSync(store.databasePath, { readOnly: true });
    expect(
      database.prepare("SELECT count(*) AS n FROM baseline_blobs").get()?.n,
    ).toBe(1);
    expect(
      database.prepare("SELECT count(*) AS n FROM project_versions").get()?.n,
    ).toBe(2);
    database.close();
    await store.close();
    const restored = await readPersistedState(filename);
    expect(stateFingerprint(restored)).toBe(stateFingerprint(state));
    expect(restored.publicFeedback.map((f) => f.id)).toEqual([
      "z-first",
      "a-second",
    ]);
    expect(restored.projects[0].acl).toBeUndefined();
    expect(restored.projects[1].acl?.version).toBe(1);
    expect(await readFile(filename, "utf8")).toBe(original);
    expect(await baselineIdentity(restored.projects[0].baseline)).toEqual(
      await baselineIdentity(place),
    );
  });

  it("resolves indexed identity/header scopes without reading geometry or unrelated tenant records", async () => {
    const { store } = await migrated();
    store.diagnostics(true);
    const headers = await store.read(
      (s) => {
        expect(s.users.map((u) => u.id)).toEqual(["u1"]);
        expect(s.memberships.map((m) => m.organizationId)).toEqual(["o1"]);
        expect(() => s.projects).toThrow("not selected");
        expect(() => s.publicFeedback).toThrow("not selected");
        return s.projectHeaders;
      },
      {
        auth: { sessionHash: "s1" },
        projectHeaders: {
          where: [{ organizationId: { auth: "organizationId" } }],
        },
      },
    );
    expect(headers.map((p) => p.project.id)).toEqual(["p1"]);
    expect(store.diagnostics()).toMatchObject({
      payloadBytes: 0,
      baselineLoads: 0,
      baselineBytes: 0,
    });
    await expect(
      store.read((s) => s.users, {
        users: { where: [{ id: { from: "organizations", field: "id" } }] },
      }),
    ).rejects.toThrow("not selected");
    await expect(
      store.read((s) => s.users, {
        users: { where: [{ id: { from: "organizations", field: "id" } }] },
        organizations: { where: [{ id: { from: "users", field: "id" } }] },
      }),
    ).rejects.toThrow("Cyclic");
  });

  it("restricts filtered deletion to selected identities and rejects unseen overwrite, missing scopes and async callbacks", async () => {
    const { store } = await migrated();
    await store.transaction(
      (s) => {
        s.sessions = [];
      },
      { sessions: { where: [{ id: "s1" }] } },
    );
    expect(
      await store.read((s) => s.sessions.map((v) => v.hash), {
        sessions: { all: true },
      }),
    ).toEqual(["s2"]);
    await expect(
      store.transaction((s) => {
        s.sessions = [];
      }, {}),
    ).rejects.toThrow("not selected");
    await expect(
      store.transaction(
        (s) => {
          s.users.push({ ...fixture().users[1], name: "overwrite attempt" });
        },
        { users: { append: true } },
      ),
    ).rejects.toThrow("unselected existing record");
    expect(
      await store.read((s) => s.users[0].name, {
        users: { where: [{ id: "u2" }] },
      }),
    ).toBe("Account 2");
    await expect(
      store.transaction(
        async (s) => {
          s.budget.policy.monthlyLimitCents = 1;
        },
        { budget: true },
      ),
    ).rejects.toThrow("synchronous");
    expect(
      await store.read((s) => s.budget.policy.monthlyLimitCents, {
        budget: true,
      }),
    ).toBe(30000);
  });

  it("patches ACL metadata atomically without overwriting payloads and detaches returned objects", async () => {
    const { store, state } = await migrated();
    store.diagnostics(true);
    const changed = await store.transaction(
      (s) => {
        s.projectHeaders[0].acl = initialProjectAcl("u1", at);
        s.audit.push({
          id: "acl-audit",
          organizationId: "o1",
          projectId: "p1",
          actorId: "u1",
          action: "test.acl",
          at,
          details: {},
        });
        return s.projectHeaders[0];
      },
      { projectHeaders: { where: [{ id: "p1" }] }, audit: { append: true } },
    );
    expect(store.diagnostics()).toMatchObject({
      payloadBytes: 0,
      baselineLoads: 0,
    });
    changed.acl!.members = [];
    const record = await store.read((s) => s.projects[0], {
      projects: { where: [{ id: "p1" }] },
    });
    expect(record.acl!.members).toHaveLength(1);
    expect(record.project).toEqual(state.projects[0].project);
    expect(record.baseline).toEqual(place);
    await expect(
      store.transaction(
        (s) => {
          s.projectHeaders[0].project.name =
            "projection cannot replace content";
        },
        { projectHeaders: { where: [{ id: "p1" }] } },
      ),
    ).rejects.toThrow("Immutable");
  });

  it("retains immutable content revisions and baselines and prevents reuse of deleted project identities", async () => {
    const { store } = await migrated();
    await expect(
      store.transaction(
        (s) => {
          s.projects[0].project.name = "unversioned change";
        },
        { projects: { where: [{ id: "p1" }] } },
      ),
    ).rejects.toThrow("version");
    await expect(
      store.transaction(
        (s) => {
          s.projects[0].baseline.name = "replacement source";
          s.projects[0].version++;
        },
        { projects: { where: [{ id: "p1" }] } },
      ),
    ).rejects.toThrow("baseline is immutable");
    await store.transaction(
      (s) => {
        s.projects[0].project.name = "Revision two";
        s.projects[0].version++;
      },
      { projects: { where: [{ id: "p1" }] } },
    );
    const database = new DatabaseSync(store.databasePath, { readOnly: true });
    const versions = database
      .prepare(
        "SELECT version,payload FROM project_versions WHERE project_id='p1' ORDER BY version",
      )
      .all() as { version: number; payload: string }[];
    expect(versions.map((r) => r.version)).toEqual([1, 2]);
    expect(JSON.parse(versions[0].payload).project.name).not.toBe(
      "Revision two",
    );
    database.close();
    await store.transaction(
      (s) => {
        s.projects = [];
      },
      { projects: { where: [{ id: "p1" }] } },
    );
    await expect(
      store.transaction(
        (s) => {
          s.projects.push(fixture().projects[0]);
        },
        { projects: { append: true } },
      ),
    ).rejects.toThrow("retired project ID");
    expect(
      await store.read((s) => s.publishedHeaders[0].id, {
        publishedHeaders: { where: [{ id: "snapshot" }] },
      }),
    ).toBe("snapshot");
  });

  it("freezes complete publications and retains them while allowing only their collection lifecycle and revocation", async () => {
    const { store } = await migrated();
    const before = await store.read((s) => s);
    const changes: ((s: DataState) => void)[] = [
      (s) => {
        s.published[0].scenario.assumptions.fiscalInputsConfirmed = true;
      },
      (s) => {
        s.published[0].results.metrics[0].value = 123456;
      },
      (s) => {
        s.published[0].projectName = "Changed published name";
      },
      (s) => {
        s.published[0].organizationId = "o2";
      },
      (s) => {
        s.published[0].feedbackEnabled = false;
      },
      (s) => {
        s.published = [];
      },
    ];
    for (const change of changes) {
      await expect(
        store.transaction(
          (s) => {
            change(s);
            s.audit.push({
              id: "must-rollback",
              organizationId: "o1",
              actorId: "u1",
              action: "invalid-publication",
              at,
              details: {},
            });
          },
          {
            published: { where: [{ id: "snapshot" }] },
            audit: { append: true },
          },
        ),
      ).rejects.toThrow(/immutable|Immutable|cannot be deleted/);
    }
    expect(stateFingerprint(await store.read((s) => s))).toBe(
      stateFingerprint(before),
    );
    await store.transaction(
      (s) => {
        s.published[0].engagement = initialEngagement(undefined, true, at);
      },
      { published: { where: [{ id: "snapshot" }] } },
    );
    for (const view of ["published", "publishedHeaders"] as const) {
      await expect(
        store.transaction(
          (s) => {
            s[view][0].engagement!.config.introduction =
              "A replacement questionnaire";
          },
          { [view]: { where: [{ id: "snapshot" }] } },
        ),
      ).rejects.toThrow("questionnaire is immutable");
      await expect(
        store.transaction(
          (s) => {
            delete s[view][0].engagement;
          },
          { [view]: { where: [{ id: "snapshot" }] } },
        ),
      ).rejects.toThrow("questionnaire is immutable");
    }
    await store.transaction(
      (s) => {
        s.published[0].engagement!.collection = {
          status: "closed",
          version: 2,
          updatedAt: at,
        };
        s.published[0].revokedAt = at;
      },
      { published: { where: [{ id: "snapshot" }] } },
    );
    const after = await store.read((s) => s.published[0], {
      published: { where: [{ id: "snapshot" }] },
    });
    expect(after).toEqual({
      ...before.published[0],
      revokedAt: at,
      engagement: {
        ...initialEngagement(undefined, true, at),
        collection: { status: "closed", version: 2, updatedAt: at },
      },
    });
  });

  it("permits legacy questionnaire materialization only with the original boolean defaults in either projection", async () => {
    const { store } = await migrated();
    for (const feedbackEnabled of [true, false]) {
      for (const view of ["published", "publishedHeaders"] as const) {
        const id = `legacy-${feedbackEnabled}-${view}`;
        await store.transaction(
          (s) => {
            s.published.push({
              ...fixture().published[0],
              id,
              feedbackEnabled,
            });
          },
          { published: { append: true } },
        );
        for (const change of [
          (config: ReturnType<typeof initialEngagement>["config"]) => {
            config.comments = !feedbackEnabled;
          },
          (config: ReturnType<typeof initialEngagement>["config"]) => {
            config.votes = !feedbackEnabled;
          },
          (config: ReturnType<typeof initialEngagement>["config"]) => {
            config.pins = !feedbackEnabled;
          },
          (config: ReturnType<typeof initialEngagement>["config"]) => {
            config.introduction = "New introduction";
          },
          (config: ReturnType<typeof initialEngagement>["config"]) => {
            config.questions = [
              {
                id: "new",
                prompt: "Unpublished question?",
                type: "text",
                required: false,
              },
            ];
          },
        ]) {
          await expect(
            store.transaction(
              (s) => {
                const engagement = initialEngagement(
                  undefined,
                  feedbackEnabled,
                  at,
                );
                change(engagement.config);
                s[view][0].engagement = engagement;
              },
              { [view]: { where: [{ id }] } },
            ),
          ).rejects.toThrow("questionnaire is immutable");
        }
        await store.transaction(
          (s) => {
            s[view][0].engagement = initialEngagement(
              undefined,
              feedbackEnabled,
              at,
            );
          },
          { [view]: { where: [{ id }] } },
        );
        expect(
          await store.read((s) => s.publishedHeaders[0].engagement, {
            publishedHeaders: { where: [{ id }] },
          }),
        ).toEqual(initialEngagement(undefined, feedbackEnabled, at));
      }
    }
  });

  it("rejects invalid SQLite project versions without coercion and rolls back every selected write", async () => {
    const { store } = await migrated();
    const before = stateFingerprint(await store.read((s) => s));
    for (const version of [
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      "2",
      null,
      undefined,
      NaN,
      Infinity,
    ]) {
      await expect(
        store.transaction(
          (s) => {
            s.projects[0].version = version as number;
            s.audit.push({
              id: "invalid-version",
              organizationId: "o1",
              actorId: "u1",
              action: "invalid-version",
              at,
              details: {},
            });
          },
          { projects: { where: [{ id: "p1" }] }, audit: { append: true } },
        ),
      ).rejects.toThrow("positive safe integer");
      expect(stateFingerprint(await store.read((s) => s))).toBe(before);
    }
    const directory = await mkdtemp(join(tmpdir(), "urban-invalid-version-"));
    directories.push(directory);
    const filename = join(directory, "state.json"),
      legacy = fixture();
    legacy.projects[0].version = -1;
    const original = JSON.stringify(legacy);
    await writeFile(filename, original);
    const rejected = new FileStore(filename);
    stores.push(rejected);
    await expect(rejected.read((s) => s.schemaVersion)).rejects.toThrow(
      "positive safe integer",
    );
    expect(await readFile(filename, "utf8")).toBe(original);
  });

  it("rejects thenables and consumes failed async callbacks without unhandled rejection or late persistence", async () => {
    const { store } = await migrated();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      for (const operation of ["read", "transaction"] as const) {
        await expect(
          store[operation](
            async (s) => {
              s.budget.policy.monthlyLimitCents = 1;
              await Promise.resolve();
              s.budget.policy.monthlyLimitCents = 2;
              throw new Error("Unsupported callback failure");
            },
            { budget: true },
          ),
        ).rejects.toThrow("synchronous");
        class RejectedThenable {
          then(_resolve: unknown, reject: (reason: unknown) => void) {
            reject(new Error("Unsupported thenable failure"));
          }
        }
        await expect(
          store[operation](
            (s) => {
              s.budget.policy.monthlyLimitCents = 3;
              return new RejectedThenable();
            },
            { budget: true },
          ),
        ).rejects.toThrow("synchronous");
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(
        await store.read((s) => s.budget.policy.monthlyLimitCents, {
          budget: true,
        }),
      ).toBe(30000);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("fails safely on corrupt baseline data while metadata remains usable", async () => {
    const { store, filename, original } = await migrated();
    const database = new DatabaseSync(store.databasePath);
    database
      .prepare("UPDATE baseline_blobs SET document=?")
      .run(JSON.stringify({ ...place, name: "corrupted" }));
    database.close();
    expect(
      await store.read((s) => s.projectHeaders.length, {
        projectHeaders: { where: [{ id: "p1" }] },
      }),
    ).toBe(1);
    await expect(
      store.read((s) => s.projects[0], { projects: { where: [{ id: "p1" }] } }),
    ).rejects.toThrow("missing or corrupt");
    expect(await readFile(filename, "utf8")).toBe(original);
  });

  it("rolls back a failed migration and refuses legacy changes after verified cutover", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "urban-migration-rollback-"),
    );
    directories.push(directory);
    const filename = join(directory, "state.json"),
      state = fixture();
    state.users.push({ ...state.users[0] });
    await writeFile(filename, JSON.stringify(state));
    const failed = new FileStore(filename);
    stores.push(failed);
    await expect(failed.read((s) => s.schemaVersion)).rejects.toThrow(
      "Duplicate",
    );
    await failed.close();
    const fixed = fixture();
    await writeFile(filename, JSON.stringify(fixed));
    const recovered = new FileStore(filename);
    stores.push(recovered);
    expect(stateFingerprint(await recovered.read((s) => s))).toBe(
      stateFingerprint(fixed),
    );
    await recovered.close();
    fixed.organizations[0].name = "Changed by an old writer";
    await writeFile(filename, JSON.stringify(fixed));
    const reopened = new FileStore(filename);
    stores.push(reopened);
    await expect(reopened.read((s) => s.schemaVersion)).rejects.toThrow(
      "legacy JSON changed",
    );
  });

  it("serializes independent local connections without losing updates and rolls back all scoped writes together", async () => {
    const { filename, store } = await migrated();
    const second = new FileStore(filename);
    stores.push(second);
    await Promise.all(
      Array.from({ length: 12 }, (_, n) =>
        (n % 2 ? store : second).transaction(
          (s) => {
            s.budget.policy.version++;
          },
          { budget: true },
        ),
      ),
    );
    expect(
      await store.read((s) => s.budget.policy.version, { budget: true }),
    ).toBe(13);
    await expect(
      store.transaction(
        (s) => {
          s.budget.policy.version++;
          s.audit.push({
            id: "rolled-back",
            organizationId: "o1",
            actorId: "u1",
            action: "rollback",
            at,
            details: {},
          });
          throw new Error("abort all changes");
        },
        { budget: true, audit: { append: true } },
      ),
    ).rejects.toThrow("abort all");
    expect(
      await second.read((s) => s.budget.policy.version, { budget: true }),
    ).toBe(13);
    expect(
      await second.read((s) => s.audit.length, {
        audit: { where: [{ id: "rolled-back" }] },
      }),
    ).toBe(0);
  });
});

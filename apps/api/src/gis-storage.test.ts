import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileStore,
  emptyState,
  type ImportRecord,
  type Store,
} from "./store.js";
const paths: string[] = [];
afterEach(async () => {
  for (const path of paths.splice(0))
    await rm(path, { recursive: true, force: true });
});
const staged: ImportRecord = {
  id: "preview",
  organizationId: "org",
  projectId: "project",
  createdBy: "user",
  source: {
    id: "source",
    name: "Fixture",
    url: "",
    vintage: "2026",
    license: "Private",
    kind: "user-supplied",
  },
  warnings: ["Known missing attributes"],
  createdAt: "2026-11-06",
  expiresAt: "2099-01-01",
  buildings: [],
};
async function exercise(store: Store) {
  await store.transaction((s) => s.imports.push(structuredClone(staged)), {
    imports: { append: true },
  });
  for (const mutate of [
    (s: ImportRecord) => {
      s.warnings = [];
    },
    (s: ImportRecord) => {
      s.source.name = "Forged";
    },
    (s: ImportRecord) => {
      s.createdBy = "other";
    },
  ]) {
    await expect(
      store.transaction(
        (s) => {
          mutate(s.imports[0]);
        },
        { imports: { where: [{ id: staged.id }] } },
      ),
    ).rejects.toThrow("immutable");
  }
  await expect(
    store.transaction(
      (s) => {
        s.imports = [];
      },
      { imports: { where: [{ id: staged.id }] } },
    ),
  ).rejects.toThrow("cannot be deleted");
  const receipt = {
    projectId: "project",
    scenarioId: "scenario",
    version: 2,
    revision: 1,
    at: "2026-11-06T00:00:00Z",
  };
  await store.transaction(
    (s) => {
      s.imports[0].committed = receipt;
    },
    { imports: { where: [{ id: staged.id }] } },
  );
  await expect(
    store.transaction(
      (s) => {
        s.imports[0].committed!.version = 3;
      },
      { imports: { where: [{ id: staged.id }] } },
    ),
  ).rejects.toThrow("immutable");
  expect(
    await store.read((s) => s.imports[0], {
      imports: { where: [{ id: staged.id }] },
    }),
  ).toEqual({ ...staged, committed: receipt });
}
describe("lightweight GIS job projections", () => {
  it("never hydrates inspection/recipe for queue headers and preserves payload across header-only changes", async () => {
    const store = new FileStore();
    const job = {
      id: "job",
      kind: "prepare" as const,
      projectId: "project",
      organizationId: "org",
      userId: "user",
      scenarioId: "scenario",
      projectVersion: 1,
      scenarioRevision: 0,
      baselineHash: "a".repeat(64),
      status: "queued" as const,
      stage: "queued" as const,
      version: 1,
      attempt: 0,
      attempts: [],
      createdAt: "2026-11-06",
      updatedAt: "2026-11-06",
      cancelRequested: false,
      idempotencyKey: "request-key",
      requestKeys: ["request-key"],
      requestHash: "b".repeat(64),
      recipe: {
        scenarioId: "scenario",
        expectedVersion: 1,
        expectedRevision: 0,
        conversion: { layerId: "source" },
        mapping: {
          layer: "buildings" as const,
          target: { mode: "append" as const },
          use: { kind: "constant" as const, value: "office" as const },
        },
        source: {
          name: "A".repeat(200),
          license: "L".repeat(2000),
          privateUseConfirmed: true,
          publicRedistribution: false,
        },
      },
    };
    try {
      await store.transaction((s) => s.gisJobs.push(job), {
        gisJobs: { append: true },
      });
      store.diagnostics(true);
      const header = await store.read((s) => s.gisJobHeaders[0], {
        gisJobHeaders: { all: true },
      });
      expect(header).not.toHaveProperty("recipe");
      expect(header).not.toHaveProperty("inspection");
      expect(store.diagnostics().payloadBytes).toBe(0);
      await store.transaction(
        (s) => {
          s.gisJobHeaders[0].cancelRequested = true;
          s.gisJobHeaders[0].status = "cancelled";
          s.gisJobHeaders[0].version++;
        },
        { gisJobHeaders: { where: [{ id: "job" }] } },
      );
      expect(
        await store.read((s) => s.gisJobs[0].recipe, {
          gisJobs: { where: [{ id: "job" }] },
        }),
      ).toEqual(job.recipe);
      await expect(
        store.transaction(
          (s) => {
            s.gisJobHeaders[0].projectId = "other";
          },
          { gisJobHeaders: { where: [{ id: "job" }] } },
        ),
      ).rejects.toThrow("Immutable");
    } finally {
      await store.close();
    }
  });
});
describe("immutable staged GIS records", () => {
  it("enforces immutable staged geometry and first commit receipt in memory", async () => {
    await exercise(new FileStore());
  });
  it("enforces the same guard durably and preserves original legacy JSON bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gis-storage-"));
    paths.push(dir);
    const path = join(dir, "state.json"),
      original = JSON.stringify(emptyState());
    await writeFile(path, original);
    const store = new FileStore(path);
    await exercise(store);
    expect(await readFile(path, "utf8")).toBe(original);
    expect(
      await new FileStore(path).read((s) => s.imports[0].committed?.version, {
        imports: { where: [{ id: "preview" }] },
      }),
    ).toBe(2);
  });
});

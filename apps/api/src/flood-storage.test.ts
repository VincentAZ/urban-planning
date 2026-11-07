import { describe, it, expect } from "vitest";
import { floodFixture } from "../../../tests/fixtures/flood";
import { floodDatasetHash, type Project } from "@urban/core";
import { encodeRecord, type StoredRow } from "./storage-core";
import { assertFloodStorageChanges } from "./flood-storage-guard";
import { validateConfiguredFlood } from "./flood-validation";
import { FloodCatalog } from "./flood-catalog";
async function fixture() {
  const f = await floodFixture();
  f.project.scenarios[1].flood!.origin = "server-catalog";
  const record = {
    project: f.project,
    baseline: f.place,
    organizationId: "org",
    version: 1,
    createdBy: "user",
    createdAt: f.dataset.capturedAt,
  };
  const registry = encodeRecord("floodSources", {
    id: f.datasetHash,
    studyAreaHash: f.dataset.studyAreaHash,
    dataset: f.dataset,
    registeredAt: f.dataset.capturedAt,
    sourceManifestHash: "a".repeat(64),
  }).row;
  const run = (project: Project, prior?: StoredRow, registered = true) => {
    const r = encodeRecord("projects", { ...record, project }).row;
    return () =>
      assertFloodStorageChanges(
        { upserts: [r], deletes: [], blobs: new Map() },
        undefined,
        (c, id) =>
          c === "projects"
            ? prior
            : c === "floodSources" && registered && id === registry.id
              ? registry
              : undefined,
        () => f.place,
      );
  };
  return { ...f, record, registry, run };
}
describe("SQLite flood evidence authority parity", () => {
  it("accepts omitted and supported methods but rejects unsupported methods in every retained reference", async () => {
    const f = await fixture();
    for (const methodVersion of [
      undefined,
      "flood-footprint-1.0.0",
      "flood-footprint-1.1.0",
    ]) {
      const p = structuredClone(f.project);
      if (methodVersion === undefined)
        delete p.scenarios[1].flood!.methodVersion;
      else
        p.scenarios[1].flood!.methodVersion =
          methodVersion as "flood-footprint-1.0.0";
      expect(f.run(p)).not.toThrow();
    }
    for (const location of [
      "current",
      "history-before",
      "history-after",
      "history-command",
      "undone-before",
      "undone-after",
      "undone-command",
    ]) {
      const p = structuredClone(f.project),
        ref = { ...p.scenarios[1].flood!, methodVersion: "unsupported" };
      if (location === "current") p.scenarios[1].flood = ref as any;
      else {
        const [collection, part] = location.split("-");
        const entry: any = {
          id: "method-entry",
          at: f.dataset.capturedAt,
          actor: "test",
          label: "Method test",
          before: structuredClone(p.scenarios[1]),
          after: structuredClone(p.scenarios[1]),
          command: {
            type: "scenario.flood",
            flood: structuredClone(p.scenarios[1].flood),
          },
        };
        entry[part].flood = ref;
        p[collection as "history" | "undone"] = [entry];
      }
      expect(f.run(p)).toThrow(/methodVersion/);
    }
  });
  it("rejects unregistered new authority but allows exact registered evidence and explicit imported provenance", async () => {
    const f = await fixture();
    expect(f.run(f.project, undefined, false)).toThrow(/Unregistered/);
    expect(f.run(f.project)).not.toThrow();
    f.project.scenarios[1].flood!.origin = "imported";
    expect(f.run(f.project, undefined, false)).not.toThrow();
  });
  it("retains exact prior authority when the runtime configuration is retired", async () => {
    const f = await fixture(),
      prior = encodeRecord("projects", f.record).row;
    expect(f.run(f.project, prior, false)).not.toThrow();
    await expect(
      validateConfiguredFlood(f.project, new FloodCatalog(), f.project),
    ).resolves.toBeUndefined();
    await expect(
      validateConfiguredFlood(f.project, new FloodCatalog()),
    ).rejects.toThrow(/not configured/);
  });
  it("rejects a method substitution in a publication even when the dataset bytes are identical", async () => {
    const f = await fixture(),
      project = encodeRecord("projects", f.record).row;
    const row: StoredRow = {
      collection: "published",
      id: "publication",
      ordinal: 0,
      indexes: { organizationId: "org", projectId: f.project.id },
      header: {},
      payload: {
        scenario: structuredClone(f.project.scenarios[1]),
        floodDataset: f.dataset,
      },
    };
    const check = () =>
      assertFloodStorageChanges(
        { upserts: [row], deletes: [], blobs: new Map() },
        undefined,
        () => project,
        () => f.place,
      );
    expect(check).not.toThrow();
    (row.payload as any).scenario.flood.methodVersion = "flood-footprint-1.1.0";
    expect(check).toThrow(/selected project source/);
    (row.payload as any).scenario.flood.methodVersion = "unsupported";
    expect(check).toThrow(/methodVersion/);
  });
  it("rejects changed or removed catalog keys even if no current scenario selects them", async () => {
    const f = await fixture(),
      prior = encodeRecord("projects", f.record).row;
    const p = structuredClone(f.project);
    delete p.scenarios[1].flood;
    p.history = [];
    p.undone = [];
    delete p.floodDatasets;
    expect(f.run(p, prior)).toThrow(/immutable/);
  });
  it("checks history/undo/command authority independently of current selected reference", async () => {
    const f = await fixture();
    const p = structuredClone(f.project);
    p.scenarios[1].flood!.origin = "imported";
    const before = structuredClone(p.scenarios[1]),
      after = structuredClone(before);
    p.history = [
      {
        id: "h",
        at: f.dataset.capturedAt,
        actor: "test",
        label: "test",
        command: {
          type: "scenario.flood",
          flood: {
            version: 1,
            datasetHash: f.datasetHash,
            origin: "server-catalog",
          },
        },
        before,
        after,
      },
    ];
    expect(f.run(p, undefined, false)).toThrow(/Unregistered/);
    p.undone = p.history;
    p.history = [];
    expect(f.run(p, undefined, false)).toThrow(/Unregistered/);
  });
  it("rejects validly rehashed source geometry bound to another study area", async () => {
    const f = await fixture(),
      p = structuredClone(f.project),
      d = structuredClone(f.dataset);
    d.studyAreaHash = "0".repeat(64);
    const h = await floodDatasetHash(d);
    p.floodDatasets = { [h]: d };
    p.scenarios[1].flood = { version: 1, datasetHash: h, origin: "imported" };
    expect(f.run(p)).toThrow(/study-area hash/);
  });
  it("never permits a request scope to register a trusted public source", async () => {
    const f = await fixture();
    expect(() =>
      assertFloodStorageChanges(
        { upserts: [f.registry], deletes: [], blobs: new Map() },
        { auth: { sessionHash: "a".repeat(64) } },
        () => undefined,
        () => f.place,
      ),
    ).toThrow(/operator/);
  });
});

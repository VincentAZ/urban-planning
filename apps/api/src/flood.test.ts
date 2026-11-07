import { describe, it, expect, vi } from "vitest";
import { baselineIdentity, floodDatasetHash } from "@urban/core";
import { FileStore } from "./store";
import {
  exerciseFloodApi,
  exerciseFloodMethodApi,
  floodApiFixture,
  registerFloodUser,
} from "./flood-test-fixture";
import * as workers from "./flood-normalization-worker";
describe("immutable flood catalog API", () => {
  it("preserves omitted legacy methods and independently publishes a reversible method-only update", async () => {
    const f = await floodApiFixture(new FileStore());
    try {
      await exerciseFloodMethodApi(f);
    } finally {
      await f.app.close();
    }
  }, 30000);
  it("serves public cached evidence and enforces scoped atomic adoption, history, exports and publication rights", async () => {
    const f = await floodApiFixture(new FileStore());
    try {
      await exerciseFloodApi(f);
    } finally {
      await f.app.close();
    }
  }, 30000);
  it("rejects an imported self-crossing pack even when its catalog hash and references are freshly recomputed", async () => {
    const f = await floodApiFixture(new FileStore());
    try {
      const owner = await registerFloodUser(f.app, "invalid-geometry");
      const dataset = structuredClone(f.dataset);
      dataset.zones[0].geometry = {
        type: "Polygon",
        coordinates: [
          [
            [-112.079, 33.441],
            [-112.071, 33.449],
            [-112.079, 33.449],
            [-112.071, 33.441],
            [-112.079, 33.441],
          ],
        ],
      };
      const hash = await floodDatasetHash(dataset),
        project = structuredClone(f.project);
      project.floodDatasets = { [hash]: dataset };
      project.history = [];
      project.undone = [];
      project.scenarios[1].flood = {
        version: 1,
        origin: "imported",
        datasetHash: hash,
      };
      const result = await f.app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: owner,
        payload: {
          project,
          baselineHash: (await baselineIdentity(f.place)).sha256,
        },
      });
      expect(result.statusCode, result.body).toBe(422);
      expect(result.json().error.code).toBe("FLOOD_INVALID");
    } finally {
      await f.app.close();
    }
  });
  it("does not publish a stale model result if the project changes while the bounded worker is calculating", async () => {
    const f = await floodApiFixture(new FileStore());
    let release!: () => void, entered!: () => void;
    const paused = new Promise<void>((resolve) => {
        release = resolve;
      }),
      started = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const actual = workers.calculateFloodImpactInWorker;
    const spy = vi
      .spyOn(workers, "calculateFloodImpactInWorker")
      .mockImplementation(async (...args) => {
        entered();
        await paused;
        return actual(...args);
      });
    try {
      const owner = await registerFloodUser(f.app, "publish-race");
      const created = await f.app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: owner,
        payload: {
          project: f.project,
          baselineHash: (await baselineIdentity(f.place)).sha256,
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const saved = created.json(),
        base = `/api/v1/projects/${saved.project.id}`;
      const publishing = f.app
        .inject({
          method: "POST",
          url: `${base}/publish`,
          headers: owner,
          payload: {
            scenarioId: f.scenario.id,
            expectedRevision: f.scenario.revision,
          },
        })
        .then((r) => r);
      await started;
      const changed = structuredClone(saved.project);
      changed.name = "Concurrent rename while computation runs";
      const update = await f.app.inject({
        method: "PUT",
        url: base,
        headers: owner,
        payload: { project: changed, expectedVersion: 1 },
      });
      expect(update.statusCode, update.body).toBe(200);
      release();
      const publication = await publishing;
      expect(publication.statusCode, publication.body).toBe(409);
      expect(publication.json().error.code).toBe("REVISION_CONFLICT");
      const audit = await f.app.inject({
        url: `${base}/audit`,
        headers: owner,
      });
      expect(audit.statusCode, audit.body).toBe(200);
      expect(
        audit
          .json()
          .audit.some(
            (row: { action: string }) => row.action === "snapshot.published",
          ),
      ).toBe(false);
    } finally {
      release();
      spy.mockRestore();
      await f.app.close();
    }
  });
});

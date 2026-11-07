import { describe, it, expect } from "vitest";
import {
  baselineIdentity,
  floodDatasetHash,
  type FloodDataset,
} from "@urban/core";
import { floodFixture } from "../../../tests/fixtures/flood";
import {
  validateFloodDatasetsInWorker,
  calculateFloodImpactInWorker,
  exportFloodInWorker,
  prepareFloodGisInWorker,
} from "./flood-normalization-worker";

describe("bounded flood CPU isolation", () => {
  it("validates exact content in the worker and cannot reuse a success after a geometry mutation", async () => {
    const f = await floodFixture();
    await validateFloodDatasetsInWorker([f.dataset]);
    const altered = structuredClone(f.dataset);
    altered.zones[0].geometry = {
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
    expect(await floodDatasetHash(altered)).not.toBe(f.datasetHash);
    await expect(validateFloodDatasetsInWorker([altered])).rejects.toThrow(
      /topology/,
    );
    await expect(validateFloodDatasetsInWorker([altered])).rejects.toThrow(
      /topology/,
    );
    await expect(
      validateFloodDatasetsInWorker([structuredClone(f.dataset)]),
    ).resolves.toBeUndefined();
  }, 15000);
  it("bounds waiting capacity, cancels queued/active work and reuses the slot only after termination", async () => {
    const f = await floodFixture(),
      input = {
        place: f.place,
        scenario: f.scenario,
        projectId: f.project.id,
        projectVersion: 1,
        baselineHash: (await baselineIdentity(f.place)).sha256,
        generatedAt: f.dataset.capturedAt,
        floodDatasets: f.project.floodDatasets,
      };
    const controller = new AbortController();
    const attempts = [0, 1, 2, 3].map(() =>
      prepareFloodGisInWorker(input, controller.signal).then(
        () => ({ code: "completed" }),
        (e) => ({ code: e.code }),
      ),
    );
    controller.abort();
    const outcomes = await Promise.all(attempts);
    expect(outcomes.map((r) => r.code)).toEqual([
      "FLOOD_CANCELLED",
      "FLOOD_CANCELLED",
      "FLOOD_CANCELLED",
      "FLOOD_WORKER_BUSY",
    ]);
    const result = await prepareFloodGisInWorker(input);
    expect(result.layers.some((l) => l.id.startsWith("flood_"))).toBe(true);
    expect(result.manifest).toHaveProperty("flood");
  }, 15000);
  it("returns exact calculated metrics and CSV evidence without running model/report geometry in the caller", async () => {
    const f = await floodFixture();
    const result = await calculateFloodImpactInWorker(
      f.place,
      f.scenario,
      f.project.floodDatasets,
    );
    expect(
      result.metrics.find((m) => m.id === "environment.flood"),
    ).toMatchObject({ baseline: 10, value: 10, delta: 0 });
    const exported = await exportFloodInWorker(
      {
        project: f.project,
        place: f.place,
        scenario: f.scenario,
        generatedAt: f.dataset.capturedAt,
        projectVersion: 1,
      },
      "flood-csv",
    );
    expect(exported.contentType).toBe("text/csv; charset=utf-8");
    expect(exported.body).toContain(f.datasetHash);
    await expect(
      exportFloodInWorker(
        {
          project: f.project,
          place: f.place,
          scenario: f.scenario,
          generatedAt: f.dataset.capturedAt,
          projectVersion: 1,
        },
        "records",
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      code: "EXPORT_RECORDS_REQUIRED",
    });
  }, 15000);
  it("keeps the event loop responsive during a nontrivial imported-ring topology check", async () => {
    const f = await floodFixture(),
      dataset: FloodDataset = structuredClone(f.dataset);
    const ring: Array<[number, number]> = Array.from(
      { length: 5000 },
      (_, i) => [
        -112.075 + 0.002 * Math.cos((i * Math.PI * 2) / 5000),
        33.445 + 0.002 * Math.sin((i * Math.PI * 2) / 5000),
      ],
    );
    ring.push([...ring[0]]);
    dataset.zones[0].geometry = { type: "Polygon", coordinates: [ring] };
    dataset.notes.push("5000-vertex bounded responsiveness fixture");
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    try {
      await validateFloodDatasetsInWorker([dataset]);
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(2);
  }, 20000);
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { floodFixture } from "../../../../tests/fixtures/flood";
import { floodDatasetHashSync } from "@urban/core";
import { executeFloodValidation } from "./flood-validation-task";
import {
  validateFloodInWorker,
  validateWorkspaceSnapshot,
  FLOOD_VALIDATION_TIMEOUT_MS,
} from "./flood-validation";

class WorkerDouble {
  static instances: WorkerDouble[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    WorkerDouble.instances.push(this);
  }
  send(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}
beforeEach(() => {
  WorkerDouble.instances = [];
  vi.stubGlobal("Worker", WorkerDouble);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("bounded flood source validation", () => {
  it("uses the worker for flood snapshot validation and releases it on success", async () => {
    const f = await floodFixture();
    const input = { project: f.project, place: f.place };
    const pending = validateWorkspaceSnapshot(input);
    const worker = WorkerDouble.instances[0];
    expect(worker.postMessage).toHaveBeenCalledWith({
      type: "snapshot",
      input,
    });
    const expected = await executeFloodValidation({ type: "snapshot", input });
    worker.send({ ok: true, value: expected });
    await expect(pending).resolves.toEqual(expected);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it("cancels a running validation and ignores a late completion", async () => {
    const f = await floodFixture(),
      controller = new AbortController();
    const pending = validateFloodInWorker(
      {
        type: "attach",
        dataset: f.dataset,
        project: f.project,
        place: f.place,
        expectedHash: f.datasetHash,
      },
      controller.signal,
    );
    const assertion = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    const worker = WorkerDouble.instances[0];
    controller.abort();
    worker.send({ ok: true, value: f.project });
    await assertion;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it("terminates an over-budget task without installing partial data", async () => {
    const f = await floodFixture();
    vi.useFakeTimers();
    const pending = validateFloodInWorker({
      type: "dataset",
      dataset: f.dataset,
      place: f.place,
      expectedHash: f.datasetHash,
    });
    const assertion = expect(pending).rejects.toThrow(/exceeded 90 seconds/);
    await vi.advanceTimersByTimeAsync(FLOOD_VALIDATION_TIMEOUT_MS);
    await assertion;
    expect(WorkerDouble.instances[0].terminate).toHaveBeenCalledOnce();
  });
  it("fails closed on worker errors and unavailable worker support", async () => {
    const f = await floodFixture(),
      task = {
        type: "dataset" as const,
        dataset: f.dataset,
        place: f.place,
        expectedHash: f.datasetHash,
      };
    const pending = validateFloodInWorker(task);
    WorkerDouble.instances[0].onerror?.();
    await expect(pending).rejects.toThrow(/worker stopped/);
    expect(WorkerDouble.instances[0].terminate).toHaveBeenCalledOnce();
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw new Error("unsupported");
        }
      },
    );
    await expect(validateFloodInWorker(task)).rejects.toThrow(/unavailable/);
  });
  it("retains hash, exact study-area and full topology validation in the background task", async () => {
    const f = await floodFixture();
    await expect(
      executeFloodValidation({
        type: "dataset",
        dataset: f.dataset,
        place: f.place,
        expectedHash: "0".repeat(64),
      }),
    ).rejects.toThrow(/identity/);
    const dataset = structuredClone(f.dataset);
    dataset.zones[0].geometry = {
      type: "Polygon",
      coordinates: [
        [
          [-112.08, 33.44],
          [-112.07, 33.45],
          [-112.08, 33.45],
          [-112.07, 33.44],
          [-112.08, 33.44],
        ],
      ],
    };
    await expect(
      executeFloodValidation({
        type: "dataset",
        dataset,
        place: f.place,
        expectedHash: floodDatasetHashSync(dataset),
      }),
    ).rejects.toThrow(/topology/);
    const other = { ...f.place, studyArea: dataset.zones[0].geometry };
    await expect(
      executeFloodValidation({
        type: "dataset",
        dataset: f.dataset,
        place: other,
        expectedHash: f.datasetHash,
      }),
    ).rejects.toThrow(/study-area/);
  });
});

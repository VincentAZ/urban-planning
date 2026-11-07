import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runNeighborhoodBrush,
  type NeighborhoodBrushRequest,
} from "./neighborhood-brush";
class TestWorker {
  static instances: TestWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  request: unknown;
  constructor() {
    TestWorker.instances.push(this);
  }
  postMessage(request: unknown) {
    this.request = request;
  }
  terminate() {
    this.terminated = true;
  }
}
const request: NeighborhoodBrushRequest = {
  draftId: "draft",
  draftRevision: 4,
  input: {
    geometry: null,
    studyArea: {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    },
    otherGeometries: [],
    stroke: { operation: "add", path: [[0.1, 0.1]], radiusMeters: 50 },
  },
};
beforeEach(() => {
  TestWorker.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("Worker", TestWorker);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("bounded neighborhood worker requests", () => {
  it("sends only exact study geometry, never the captured city bundle", async () => {
    const value = {
      ...request,
      input: {
        ...request.input,
        studyArea: {
          boundary: [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ] as [number, number][],
          buildings: [{ privateFixture: "not needed by geometry" }],
        },
      },
    };
    const promise = runNeighborhoodBrush(value),
      worker = TestWorker.instances[0];
    expect(
      (worker.request as NeighborhoodBrushRequest).input.studyArea,
    ).toEqual({
      type: "Polygon",
      coordinates: [value.input.studyArea.boundary],
    });
    worker.onmessage?.({
      data: {
        draftId: value.draftId,
        draftRevision: value.draftRevision,
        result: { geometry: null, changed: false },
      },
    });
    await promise;
  });

  it("returns one generation-bound result and releases the worker", async () => {
    const promise = runNeighborhoodBrush(request),
      worker = TestWorker.instances[0];
    const response = {
      draftId: "draft",
      draftRevision: 4,
      result: { geometry: null, changed: false },
    };
    worker.onmessage?.({ data: response });
    expect(await promise).toBe(response);
    expect(worker.terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("aborts calculation and ignores a late result from the prior editing session", async () => {
    const controller = new AbortController(),
      promise = runNeighborhoodBrush(request, { signal: controller.signal }),
      worker = TestWorker.instances[0];
    const rejected = expect(promise).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    worker.onmessage?.({
      data: { draftId: "draft", draftRevision: 4, result: { changed: true } },
    });
    await rejected;
    expect(worker.terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects a mismatched result instead of applying a newer draft from stale geometry", async () => {
    const promise = runNeighborhoodBrush(request),
      worker = TestWorker.instances[0];
    worker.onmessage?.({
      data: { draftId: "draft", draftRevision: 3, result: { changed: true } },
    });
    await expect(promise).rejects.toThrow(/earlier draft/);
    expect(worker.terminated).toBe(true);
  });
  it("terminates excessive work with an honest unchanged-boundary error", async () => {
    const promise = runNeighborhoodBrush(request),
      rejected = expect(promise).rejects.toThrow(/calculation budget/);
    vi.advanceTimersByTime(10000);
    await rejected;
    expect(TestWorker.instances[0].terminated).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { floodFixture } from "../../../../tests/fixtures/flood";
import {
  ImpactClient,
  IMPACT_TIMEOUT_MS,
  type ImpactOutcome,
} from "./impact-client";
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
  send(requestId: number, values: ImpactOutcome[]) {
    this.onmessage?.({ data: { requestId, values } } as MessageEvent);
  }
}
const value = {
  results: { metrics: [] },
  flood: { datasetHash: "test" },
} as unknown as ImpactOutcome;
beforeEach(() => {
  WorkerDouble.instances = [];
  vi.stubGlobal("Worker", WorkerDouble);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("impact worker scope and bounded lifecycle", () => {
  it("retains the immutable catalog in one worker across completed edits and sends it only when changed", async () => {
    const f = await floodFixture(),
      client = new ImpactClient();
    const first = client.calculate(f.place, [f.scenario], f.context),
      worker = WorkerDouble.instances[0];
    worker.send(1, [value]);
    await first;
    const second = client.calculate(
      f.place,
      [{ ...f.scenario, revision: 2 }],
      f.context,
    );
    expect(WorkerDouble.instances).toHaveLength(1);
    expect(
      worker.postMessage.mock.calls.filter(([m]) => m.type === "context"),
    ).toHaveLength(1);
    worker.send(2, [value]);
    await second;
    const replacement = { floodDatasets: { ...f.context.floodDatasets } };
    const third = client.calculate(f.place, [f.scenario], replacement);
    expect(
      worker.postMessage.mock.calls.filter(([m]) => m.type === "context"),
    ).toHaveLength(2);
    worker.send(3, [value]);
    await third;
    client.dispose();
  });
  it("terminates superseded work and rejects old replies, even for the same scenario ID/revision", async () => {
    const f = await floodFixture(),
      client = new ImpactClient(),
      controller = new AbortController();
    const old = client.calculate(
      f.place,
      [f.scenario],
      f.context,
      controller.signal,
    );
    const oldAssertion = expect(old).rejects.toMatchObject({
      name: "AbortError",
    });
    const oldWorker = WorkerDouble.instances[0];
    controller.abort();
    const current = client.calculate({ ...f.place }, [f.scenario], {
      ...f.context,
    });
    const next = WorkerDouble.instances[1];
    oldWorker.send(1, [value]);
    expect(oldWorker.terminate).toHaveBeenCalledOnce();
    next.send(2, [value]);
    await oldAssertion;
    await expect(current).resolves.toEqual([value]);
    client.dispose();
  });
  it("calculates a bounded four-scenario batch and fails closed on an incomplete response", async () => {
    const f = await floodFixture(),
      client = new ImpactClient();
    const scenarios = Array.from({ length: 4 }, (_, i) => ({
      ...f.scenario,
      id: `s${i}`,
    }));
    const task = client.calculate(f.place, scenarios, f.context);
    expect(WorkerDouble.instances[0].postMessage).toHaveBeenLastCalledWith({
      type: "calculate",
      scenarios,
      requestId: 1,
    });
    WorkerDouble.instances[0].send(1, [value]);
    await expect(task).rejects.toThrow(/incomplete comparison/);
    await expect(
      client.calculate(f.place, [...scenarios, f.scenario], f.context),
    ).rejects.toThrow(/one to four/);
    expect(WorkerDouble.instances).toHaveLength(1);
    client.dispose();
  });
  it("terminates a timed-out calculation and can retry with a fresh worker", async () => {
    const f = await floodFixture(),
      client = new ImpactClient();
    vi.useFakeTimers();
    const pending = client.calculate(f.place, [f.scenario], f.context);
    const assertion = expect(pending).rejects.toThrow(/exceeded 90 seconds/);
    await vi.advanceTimersByTimeAsync(IMPACT_TIMEOUT_MS);
    await assertion;
    expect(WorkerDouble.instances[0].terminate).toHaveBeenCalledOnce();
    const retry = client.calculate(f.place, [f.scenario], f.context);
    WorkerDouble.instances[1].send(2, [value]);
    await retry;
    client.dispose();
  });
});

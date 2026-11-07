import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrafficCommuteSummary } from "@urban/core";
import type { TrafficCommuteLedgerView } from "./traffic-commute-ledger";
import { inspectTrafficCommuteLedger } from "./traffic-commute-ledger-client";

class ControlledWorker {
  static instances: ControlledWorker[] = [];
  static failToPost = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn(
    (
      message: {
        bytes: ArrayBuffer;
        summary: TrafficCommuteSummary;
        file: { sha256: string; bytes: number };
      },
      transfers: ArrayBuffer[],
    ) => {
      if (ControlledWorker.failToPost)
        throw new Error("Structured clone failed");
      void message;
      void transfers;
    },
  );
  terminate = vi.fn();
  constructor() {
    ControlledWorker.instances.push(this);
  }
  send(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}
const binding = {
  version: 1 as const,
  presetId: "selected-preset",
  assetHash: "a".repeat(64),
  sourcePackHash: "b".repeat(64),
  priorHash: "c".repeat(64),
  routesHash: "d".repeat(64),
  compilationHash: "e".repeat(64),
  demandHash: "f".repeat(64),
  periodHash: "1".repeat(64),
  networkHash: "2".repeat(64),
  inventoryHash: "3".repeat(64),
};
// This client transports evidence; numeric validation is exercised through the real helper tests.
const summary = { binding } as TrafficCommuteSummary;
const view = { binding: { ...binding } } as TrafficCommuteLedgerView;
const file = { sha256: "4".repeat(64), bytes: 2 };
function blob() {
  return {
    size: 2,
    arrayBuffer: vi.fn(async () => new Uint8Array([1, 2]).buffer),
  } as unknown as Blob;
}
async function started() {
  await Promise.resolve();
  await Promise.resolve();
  const worker = ControlledWorker.instances.at(-1);
  expect(worker).toBeDefined();
  return worker!;
}
beforeEach(() => {
  ControlledWorker.instances = [];
  ControlledWorker.failToPost = false;
  vi.useFakeTimers();
  vi.stubGlobal("Worker", ControlledWorker);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("bounded commute ledger worker lifecycle", () => {
  it("transfers exact bytes and releases the worker on successful inspection", async () => {
    const controller = new AbortController(),
      promise = inspectTrafficCommuteLedger(
        blob(),
        summary,
        file,
        controller.signal,
      ),
      worker = await started();
    expect(worker.postMessage).toHaveBeenCalledOnce();
    const [message, transfers] = worker.postMessage.mock.calls[0];
    expect(message).toMatchObject({ summary, file });
    expect(new Uint8Array(message.bytes)).toEqual(new Uint8Array([1, 2]));
    expect(transfers).toEqual([message.bytes]);
    worker.send({ ok: true, view });
    await expect(promise).resolves.toEqual(view);
    controller.abort();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start work for an already cancelled or oversized request", async () => {
    const controller = new AbortController();
    controller.abort();
    const input = blob();
    await expect(
      inspectTrafficCommuteLedger(input, summary, file, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(input.arrayBuffer).not.toHaveBeenCalled();
    await expect(
      inspectTrafficCommuteLedger(blob(), summary, { ...file, bytes: 3 }),
    ).rejects.toThrow(/bound|size/);
    expect(ControlledWorker.instances).toHaveLength(0);
  });

  it("cancels during byte reading before creating a worker", async () => {
    let release!: (value: ArrayBuffer) => void;
    const bytes = new Promise<ArrayBuffer>((resolve) => {
      release = resolve;
    });
    const input = { size: 2, arrayBuffer: () => bytes } as Blob,
      controller = new AbortController();
    const promise = inspectTrafficCommuteLedger(
      input,
      summary,
      file,
      controller.signal,
    );
    const rejected = expect(promise).rejects.toMatchObject({
      name: "AbortError",
    });
    controller.abort();
    release(new ArrayBuffer(2));
    await rejected;
    expect(ControlledWorker.instances).toHaveLength(0);
  });

  it("aborts a superseded inspection and ignores its late response while the new one succeeds", async () => {
    const controller = new AbortController();
    const old = inspectTrafficCommuteLedger(
      blob(),
      summary,
      file,
      controller.signal,
    );
    const rejected = expect(old).rejects.toMatchObject({ name: "AbortError" });
    const previous = await started();
    controller.abort();
    await rejected;
    const nextSummary = {
      binding: {
        ...binding,
        compilationHash: "5".repeat(64),
        assetHash: "6".repeat(64),
      },
    } as TrafficCommuteSummary;
    const current = inspectTrafficCommuteLedger(blob(), nextSummary, file),
      worker = await started();
    previous.send({ ok: true, view });
    const nextView = {
      binding: nextSummary.binding,
    } as TrafficCommuteLedgerView;
    worker.send({ ok: true, view: nextView });
    await expect(current).resolves.toEqual(nextView);
    expect(previous.terminate).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("rejects a mixed evidence identity even when asset and compilation hashes are unchanged", async () => {
    const promise = inspectTrafficCommuteLedger(blob(), summary, file),
      worker = await started();
    const rejected = expect(promise).rejects.toThrow(/different preparation/);
    worker.send({
      ok: true,
      view: { ...view, binding: { ...binding, periodHash: "9".repeat(64) } },
    });
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it.each([null, {}, { ok: true, view: {} }])(
    "rejects malformed worker responses promptly: %j",
    async (message) => {
      const promise = inspectTrafficCommuteLedger(blob(), summary, file),
        worker = await started();
      const rejected = expect(promise).rejects.toThrow();
      expect(() => worker.send(message)).not.toThrow();
      await rejected;
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["error", "messageerror", "timeout", "postMessage"] as const)(
    "releases capacity on %s without showing partial records",
    async (failure) => {
      ControlledWorker.failToPost = failure === "postMessage";
      const promise = inspectTrafficCommuteLedger(blob(), summary, file),
        worker = await started();
      const rejected = expect(promise).rejects.toThrow();
      if (failure === "error") worker.onerror?.();
      if (failure === "messageerror") worker.onmessageerror?.();
      if (failure === "timeout") await vi.advanceTimersByTimeAsync(30000);
      await rejected;
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});

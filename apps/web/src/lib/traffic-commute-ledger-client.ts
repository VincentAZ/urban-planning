import type { TrafficCommuteSummary } from "@urban/core";
import type { TrafficCommuteLedgerView } from "./traffic-commute-ledger";

/** Explicit, bounded background inspection; every terminal path releases the worker. */
export async function inspectTrafficCommuteLedger(
  blob: Blob,
  summary: TrafficCommuteSummary,
  file: { sha256: string; bytes: number },
  signal?: AbortSignal,
): Promise<TrafficCommuteLedgerView> {
  const aborted = () =>
    new DOMException("Commute inspection cancelled", "AbortError");
  if (signal?.aborted) throw aborted();
  if (blob.size !== file.bytes || blob.size > 16 * 1024 ** 2)
    throw new Error(
      "The complete commute evidence exceeds its inspection bound or changed size.",
    );
  const bytes = await blob.arrayBuffer();
  if (signal?.aborted) throw aborted();
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(
        new URL("./traffic-commute-ledger.worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch {
      reject(
        new Error(
          "Background ledger inspection is unavailable in this browser. The complete evidence download is still available.",
        ),
      );
      return;
    }
    let done = false;
    const finish = (error?: Error, view?: TrafficCommuteLedgerView) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      worker.terminate();
      if (error) reject(error);
      else resolve(view!);
    };
    const cancel = () => finish(aborted());
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "Ledger inspection exceeded 30 seconds. No partial table was displayed; the full evidence download remains available.",
          ),
        ),
      30000,
    );
    signal?.addEventListener("abort", cancel, { once: true });
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data as {
        ok?: unknown;
        view?: TrafficCommuteLedgerView;
        error?: unknown;
      } | null;
      const binding = value?.view?.binding;
      if (
        value?.ok !== true ||
        !binding ||
        Object.keys(binding).length !== Object.keys(summary.binding).length ||
        Object.entries(summary.binding).some(
          ([key, expected]) =>
            binding[key as keyof typeof binding] !== expected,
        )
      ) {
        finish(
          new Error(
            typeof value?.error === "string"
              ? value.error
              : "The inspected ledger belongs to a different preparation or returned an invalid response.",
          ),
        );
      } else finish(undefined, value.view);
    };
    worker.onerror = () =>
      finish(
        new Error(
          "Background ledger inspection failed. No partial table was displayed.",
        ),
      );
    worker.onmessageerror = () =>
      finish(
        new Error("The inspected ledger could not be transferred safely."),
      );
    if (signal?.aborted) {
      cancel();
      return;
    }
    try {
      worker.postMessage({ bytes, summary, file }, [bytes]);
    } catch {
      finish(
        new Error("The retained evidence could not be sent for inspection."),
      );
    }
  });
}

import type { TrafficCommuteSummary } from "@urban/core";
import { readTrafficCommuteLedger } from "./traffic-commute-ledger";

self.onmessage = async (
  event: MessageEvent<{
    bytes: ArrayBuffer;
    summary: TrafficCommuteSummary;
    file: { sha256: string; bytes: number };
  }>,
) => {
  try {
    const view = await readTrafficCommuteLedger(
      event.data.bytes,
      event.data.summary,
      event.data.file,
    );
    self.postMessage({ ok: true, view });
  } catch (error) {
    self.postMessage({
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "The retained commute ledger could not be read.",
    });
  }
};

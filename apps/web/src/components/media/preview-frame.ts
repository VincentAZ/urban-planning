import type {
  MapExportAck,
  MapExportFrame,
  MapExportHandle,
} from "../map/export-frame";

/** React may replace a newly mounted map (including StrictMode replay). Only a proven new owner may retry. */
export async function renderCurrentExportFrame(
  current: () => MapExportHandle | null,
  frame: MapExportFrame,
  signal: AbortSignal,
  nextPaint: () => Promise<void> = () =>
    new Promise((resolve) => requestAnimationFrame(() => resolve())),
): Promise<MapExportAck> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new Error(
          "The preview renderer did not finish within its rendering limit.",
        ),
      ),
    15000,
  );
  try {
    while (true) {
      controller.signal.throwIfAborted();
      // A completed paint also lets the mount/cleanup/remount lifecycle settle.
      await nextPaint();
      controller.signal.throwIfAborted();
      const owner = current();
      if (!owner) continue;
      try {
        const acknowledgement = await owner.renderFrame(
          frame,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        if (current() !== owner) continue;
        return acknowledgement;
      } catch (error) {
        controller.signal.throwIfAborted();
        if (current() !== owner) continue;
        throw error;
      }
    }
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", cancel);
    controller.abort();
  }
}

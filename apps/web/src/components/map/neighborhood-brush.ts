import { studyAreaGeometry } from "@urban/core";
import type {
  NeighborhoodBrushInput,
  NeighborhoodBrushResult,
} from "@urban/core";
export interface NeighborhoodBrushRequest {
  draftId: string;
  draftRevision: number;
  input: NeighborhoodBrushInput;
}
export interface NeighborhoodBrushResponse {
  draftId: string;
  draftRevision: number;
  result: NeighborhoodBrushResult;
}
/** Isolated bounded work per completed stroke. Aborting terminates calculation; no deferred result can commit. */
export function runNeighborhoodBrush(
  request: NeighborhoodBrushRequest,
  options: { signal?: AbortSignal } = {},
): Promise<NeighborhoodBrushResponse> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException("Brush cancelled.", "AbortError"));
      return;
    }
    const worker = new Worker(
      new URL("./neighborhood-brush.worker.ts", import.meta.url),
      { type: "module" },
    );
    let finished = false;
    const timeout = window.setTimeout(() => {
      if (!finished) {
        cleanup();
        reject(
          new Error(
            "This brush operation exceeded the calculation budget. Use a shorter stroke or a smaller boundary; your prior boundary is unchanged.",
          ),
        );
      }
    }, 10000);
    const cleanup = () => {
      finished = true;
      worker.terminate();
      window.clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      if (!finished) {
        cleanup();
        reject(new DOMException("Brush cancelled.", "AbortError"));
      }
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (
      event: MessageEvent<NeighborhoodBrushResponse & { error?: string }>,
    ) => {
      if (finished) return;
      cleanup();
      const value = event.data;
      if (
        value.draftId !== request.draftId ||
        value.draftRevision !== request.draftRevision
      )
        reject(new Error("The brush result belongs to an earlier draft."));
      else if (value.error) reject(new Error(value.error));
      else resolve(value);
    };
    const failWorker = () => {
      if (!finished) {
        cleanup();
        reject(
          new Error(
            "The brush worker could not finish. Your prior boundary is unchanged.",
          ),
        );
      }
    };
    worker.onerror = failWorker;
    worker.onmessageerror = failWorker;
    try {
      worker.postMessage({
        ...request,
        input: {
          ...request.input,
          studyArea: studyAreaGeometry(request.input.studyArea),
        },
      });
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

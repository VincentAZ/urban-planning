import type { ModelResults, Place, Scenario } from "@urban/core";
import type { FloodResolution, ModelContext } from "@urban/models";

export interface ImpactOutcome {
  results: ModelResults;
  flood: FloodResolution;
}
export const IMPACT_TIMEOUT_MS = 90_000;

/** One warm geometry cache per consumer; superseded in-flight work is terminated. */
export class ImpactClient {
  private worker: Worker | null = null;
  private place: Place | null = null;
  private context: ModelContext | undefined;
  private cancel: (() => void) | null = null;
  private sequence = 0;

  dispose() {
    this.cancel?.();
    this.worker?.terminate();
    this.worker = null;
    this.place = null;
    this.context = undefined;
  }

  calculate(
    place: Place,
    scenarios: Scenario[],
    context?: ModelContext,
    signal?: AbortSignal,
  ): Promise<ImpactOutcome[]> {
    if (signal?.aborted)
      return Promise.reject(
        new DOMException("Calculation cancelled", "AbortError"),
      );
    if (!scenarios.length || scenarios.length > 4)
      return Promise.reject(
        new Error("Choose one to four scenarios to calculate."),
      );
    this.cancel?.();
    const requestId = ++this.sequence;
    return new Promise((resolve, reject) => {
      let worker: Worker;
      try {
        worker =
          this.worker ??
          new Worker(new URL("./impact.worker.ts", import.meta.url), {
            type: "module",
          });
        this.worker = worker;
      } catch {
        reject(
          new Error("Background calculations are unavailable in this browser."),
        );
        return;
      }
      let finished = false;
      const finish = (error?: Error, values?: ImpactOutcome[]) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        this.cancel = null;
        if (error) {
          worker.terminate();
          if (this.worker === worker) {
            this.worker = null;
            this.place = null;
            this.context = undefined;
          }
          reject(error);
        } else resolve(values!);
      };
      const cancel = () =>
        finish(new DOMException("Calculation cancelled", "AbortError"));
      this.cancel = cancel;
      const timer = setTimeout(
        () =>
          finish(
            new Error(
              "Calculation exceeded 90 seconds. No partial results are displayed. Reduce the comparison or reopen the project to retry.",
            ),
          ),
        IMPACT_TIMEOUT_MS,
      );
      signal?.addEventListener("abort", cancel, { once: true });
      worker.onmessage = ({ data }) => {
        if (data?.requestId !== requestId) return;
        if (signal?.aborted) return cancel();
        if (data.error) finish(new Error(data.error));
        else if (
          Array.isArray(data.values) &&
          data.values.length === scenarios.length
        )
          finish(undefined, data.values);
        else
          finish(
            new Error(
              "The calculation worker returned an incomplete comparison.",
            ),
          );
      };
      worker.onerror = () =>
        finish(
          new Error(
            "The calculation worker stopped. Reopen the project to retry.",
          ),
        );
      worker.onmessageerror = () =>
        finish(
          new Error("The calculated results could not be transferred safely."),
        );
      try {
        if (this.place !== place) {
          worker.postMessage({ type: "place", place });
          this.place = place;
        }
        if (this.context !== context) {
          worker.postMessage({ type: "context", context });
          this.context = context;
        }
        worker.postMessage({ type: "calculate", scenarios, requestId });
      } catch {
        finish(
          new Error(
            "The scenario could not be sent for background calculation.",
          ),
        );
      }
    });
  }
}

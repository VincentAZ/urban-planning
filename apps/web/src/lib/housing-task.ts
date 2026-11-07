import type {
  HousingAffordabilityResolution,
  HousingAffordabilityScenario,
  HousingIncomeLimitCatalog,
  Place,
  Project,
  Scenario,
} from "@urban/core";
export type HousingTask =
  | {
      kind: "preview";
      place: Place;
      scenario: Scenario;
      input: Pick<
        HousingAffordabilityScenario,
        "baselineGroups" | "proposalGroups" | "sources"
      >;
      review: Omit<HousingAffordabilityScenario["review"], "inputHash">;
      catalog: HousingIncomeLimitCatalog;
    }
  | {
      kind: "apply";
      place: Place;
      project: Project;
      affordability: HousingAffordabilityScenario;
      catalog: HousingIncomeLimitCatalog;
    };
export interface HousingPreview {
  affordability: HousingAffordabilityScenario;
  result: HousingAffordabilityResolution;
}
export function runHousingTask<T>(
  task: HousingTask,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./housing-task.worker.ts", import.meta.url),
      { type: "module" },
    );
    let finished = false;
    const finish = (value?: T, error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      worker.terminate();
      error ? reject(error) : resolve(value!);
    };
    const cancel = () =>
      finish(
        undefined,
        new DOMException("Housing review cancelled", "AbortError"),
      );
    const timer = setTimeout(
      () =>
        finish(
          undefined,
          new Error(
            "Housing review exceeded 60 seconds. No partial evidence was applied.",
          ),
        ),
      60000,
    );
    signal?.addEventListener("abort", cancel, { once: true });
    worker.onmessage = ({ data }) =>
      data.error
        ? finish(undefined, new Error(data.error))
        : finish(data.value);
    worker.onerror = () =>
      finish(
        undefined,
        new Error(
          "The housing review worker stopped. Your draft is unchanged.",
        ),
      );
    worker.onmessageerror = () =>
      finish(
        undefined,
        new Error("Housing review returned an unreadable result."),
      );
    worker.postMessage(task);
  });
}

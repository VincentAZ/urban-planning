import type {
  FiscalProfile,
  FiscalResolution,
  FiscalStudy,
  Place,
  Project,
  Scenario,
} from "@urban/core";
export type FiscalStudyInput = {
  place: Place;
  project: Project;
  scenarioId: string;
  profile: FiscalProfile;
  review: {
    reviewedBy: string;
    reviewedAt: string;
    applicabilityNotes: string;
  };
  name?: string;
};
export type FiscalTask =
  | { kind: "preview"; place: Place; study: FiscalStudy; scenario: Scenario }
  | { kind: "create"; input: FiscalStudyInput };
function run<T>(task: FiscalTask, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./fiscal-task.worker.ts", import.meta.url),
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
        new DOMException("Fiscal calculation cancelled", "AbortError"),
      );
    const timer = setTimeout(
      () =>
        finish(
          undefined,
          new Error(
            "Fiscal preparation exceeded 60 seconds. No partial study was applied.",
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
          "The fiscal calculation worker stopped. Your draft remains unchanged.",
        ),
      );
    worker.onmessageerror = () =>
      finish(
        undefined,
        new Error("Fiscal calculation returned an unreadable result."),
      );
    worker.postMessage(task);
  });
}
export const previewFiscalStudy = (
  place: Place,
  study: FiscalStudy,
  scenario: Scenario,
  signal?: AbortSignal,
) => run<FiscalResolution>({ kind: "preview", place, study, scenario }, signal);
export const createFiscalStudyInWorker = (
  input: FiscalStudyInput,
  signal?: AbortSignal,
) => run<Project>({ kind: "create", input }, signal);

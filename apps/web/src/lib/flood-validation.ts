import { validateProjectSnapshot, type ProjectSnapshot } from "@urban/core";
import type {
  FloodValidationTask,
  FloodValidationResults,
} from "./flood-validation-task";

export const FLOOD_VALIDATION_TIMEOUT_MS = 90_000;

/** A fresh worker bounds untrusted topology validation; every exit terminates it. */
export function validateFloodInWorker<T extends FloodValidationTask["type"]>(
  task: Extract<FloodValidationTask, { type: T }>,
  signal?: AbortSignal,
): Promise<FloodValidationResults[T]> {
  if (signal?.aborted)
    return Promise.reject(
      new DOMException("Flood validation cancelled", "AbortError"),
    );
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(
        new URL("./flood-validation.worker.ts", import.meta.url),
        { type: "module" },
      );
    } catch {
      reject(
        new Error(
          "Background source validation is unavailable. The existing project has not changed.",
        ),
      );
      return;
    }
    let finished = false;
    const finish = (error?: Error, value?: FloodValidationResults[T]) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      worker.terminate();
      if (error) reject(error);
      else resolve(value!);
    };
    const cancel = () =>
      finish(new DOMException("Flood validation cancelled", "AbortError"));
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "Flood source validation exceeded 90 seconds. The existing project has not changed.",
          ),
        ),
      FLOOD_VALIDATION_TIMEOUT_MS,
    );
    signal?.addEventListener("abort", cancel, { once: true });
    worker.onmessage = ({ data }) => {
      if (signal?.aborted) return cancel();
      if (data?.ok === true && data.value) finish(undefined, data.value);
      else
        finish(
          new Error(
            typeof data?.error === "string"
              ? data.error
              : "Flood source validation failed.",
          ),
        );
    };
    worker.onerror = () =>
      finish(
        new Error(
          "The source validation worker stopped. The existing project has not changed.",
        ),
      );
    worker.onmessageerror = () =>
      finish(
        new Error("The validated source could not be transferred safely."),
      );
    try {
      worker.postMessage(task);
    } catch {
      finish(
        new Error("The source could not be sent for background validation."),
      );
    }
  });
}

export function validateWorkspaceSnapshot(
  input: unknown,
  signal?: AbortSignal,
): Promise<ProjectSnapshot> {
  const project =
    input && typeof input === "object" && "project" in input
      ? input.project
      : null;
  // Invalid catalogs are sent to the same validator; this is scheduling, not a trust bypass.
  if (project && typeof project === "object" && "floodDatasets" in project)
    return validateFloodInWorker({ type: "snapshot", input }, signal);
  signal?.throwIfAborted();
  return validateProjectSnapshot(input);
}

import {
  executeFloodValidation,
  type FloodValidationTask,
} from "./flood-validation-task";

/** Test transport only: execute the real validation task after a microtask boundary. */
export class TestFloodValidationWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  private stopped = false;
  postMessage(task: FloodValidationTask) {
    const input = structuredClone(task);
    queueMicrotask(() => {
      void executeFloodValidation(input).then(
        (value) => {
          if (!this.stopped)
            this.onmessage?.({ data: { ok: true, value } } as MessageEvent);
        },
        (error) => {
          if (!this.stopped)
            this.onmessage?.({
              data: { ok: false, error: error.message },
            } as MessageEvent);
        },
      );
    });
  }
  terminate() {
    this.stopped = true;
  }
}

import { createFiscalStudy, resolveFiscalStudy } from "@urban/models";
import type { FiscalTask } from "./fiscal-task";
self.onmessage = (event: MessageEvent<FiscalTask>) => {
  try {
    const task = event.data;
    const value =
      task.kind === "preview"
        ? resolveFiscalStudy(
            task.place,
            { fiscalStudy: task.study },
            task.scenario,
          )
        : createFiscalStudy(task.input);
    self.postMessage({ value });
  } catch (error) {
    self.postMessage({
      error:
        error instanceof Error ? error.message : "Fiscal calculation failed.",
    });
  }
};

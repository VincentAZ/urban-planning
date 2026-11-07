import {
  executeFloodValidation,
  type FloodValidationTask,
} from "./flood-validation-task";
self.onmessage = async (event: MessageEvent<FloodValidationTask>) => {
  try {
    self.postMessage({
      ok: true,
      value: await executeFloodValidation(event.data),
    });
  } catch (error) {
    self.postMessage({
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Flood source validation failed.",
    });
  }
};

import { executeHousingTask } from "./housing-task-executor";
import type { HousingTask } from "./housing-task";
self.onmessage = ({ data: task }: MessageEvent<HousingTask>) => {
  try {
    self.postMessage({ value: executeHousingTask(task) });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : "Housing review failed.",
    });
  }
};

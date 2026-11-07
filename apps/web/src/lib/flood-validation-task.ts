import {
  floodDatasetHashSync,
  projectWithFloodDataset,
  validateFloodDataset,
  validateProjectSnapshot,
  type FloodDataset,
  type Place,
  type Project,
  type ProjectSnapshot,
} from "@urban/core";

export type FloodValidationTask =
  | {
      type: "dataset";
      dataset: FloodDataset;
      place: Place;
      expectedHash: string;
    }
  | {
      type: "attach";
      dataset: FloodDataset;
      place: Place;
      project: Project;
      expectedHash: string;
    }
  | { type: "snapshot"; input: unknown };
export interface FloodValidationResults {
  dataset: FloodDataset;
  attach: Project;
  snapshot: ProjectSnapshot;
}

/** Runs only in the validation worker; all ordinary core validation is retained. */
export async function executeFloodValidation(task: FloodValidationTask) {
  if (task.type === "snapshot") return validateProjectSnapshot(task.input);
  if (floodDatasetHashSync(task.dataset) !== task.expectedHash)
    throw new Error(
      "The flood map does not match its retained content identity.",
    );
  if (task.type === "attach")
    return projectWithFloodDataset(task.project, task.dataset, task.place);
  validateFloodDataset(task.dataset, task.place);
  return task.dataset;
}

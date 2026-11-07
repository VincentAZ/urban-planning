import { floodDatasetHashSync, validateFloodDataset } from "@urban/core";
import { ApiError } from "./errors";
import { calculateImpact } from "@urban/models";
import type { FloodDataset } from "@urban/core";
/** Trusted fixed task dispatcher. No client code, path, module or native command selection. */
export async function runFloodWorkerTask(task: any): Promise<unknown> {
  const result = await execute(task);
  const body = (result as { body?: unknown })?.body;
  const bytes =
    body instanceof Uint8Array
      ? body.byteLength
      : Buffer.byteLength(JSON.stringify(result));
  if (bytes > 160 * 1024 * 1024)
    throw new ApiError(
      413,
      "FLOOD_WORKER_OUTPUT_LIMIT",
      "Flood processing output exceeds 160 MiB; no data was truncated.",
    );
  return result;
}
async function execute(task: any): Promise<unknown> {
  if (task.kind === "normalize")
    return (await import("./data/flood")).deriveFloodDataset(
      task.area,
      task.capturedAt,
      task.responses.map((r: any) => ({ ...r, body: Buffer.from(r.body) })),
    );
  if (task.kind === "validate")
    return task.datasets.map(
      (item: { hash: string; dataset: FloodDataset }) => {
        validateFloodDataset(item.dataset);
        if (floodDatasetHashSync(item.dataset) !== item.hash)
          throw new Error("Flood validation input hash mismatch.");
        return item.hash;
      },
    );
  if (task.kind === "model")
    return calculateImpact(
      task.place,
      task.scenario,
      {},
      {
        floodDatasets: task.floodDatasets,
        fiscalStudy: task.fiscalStudy,
        housingIncomeLimits: task.housingIncomeLimits,
      },
    );
  if (task.kind === "export")
    return (await import("./flood-export-task")).exportFloodTask(
      task.snapshot,
      task.format,
      task.records,
    );
  if (task.kind === "gis")
    return (await import("./flood-export-task")).prepareFloodGisTask(
      task.input,
    );
  throw new Error("Unsupported fixed flood worker task.");
}

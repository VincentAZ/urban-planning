import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  floodDatasetHashSync,
  type FloodDataset,
  type ModelResults,
  type Place,
  type Scenario,
  type StudyAreaGeometry,
  type FloodDatasetCatalog,
} from "@urban/core";
import type { FloodResponse } from "./data/flood";
import { ApiError } from "./errors";
import type {
  FloodExportFormat,
  FloodExportSnapshot,
  FloodExportRecords,
} from "./flood-export-task";
import type { exportFloodTask, prepareFloodGisTask } from "./flood-export-task";
export const FLOOD_WORKER_LIMITS = {
  concurrency: 1,
  waiting: 2,
  queueMs: 30000,
  executionMs: 60000,
  oldHeapMiB: 512,
  inputBytes: 160 * 1024 * 1024,
  outputBytes: 160 * 1024 * 1024,
} as const;
let active = false;
type Task = {
  start: () => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abort?: () => void;
  signal?: AbortSignal;
};
const waiting: Task[] = [];
const validated = new Set<string>();
function remember(hash: string) {
  if (validated.size >= 64) validated.delete(validated.values().next().value!);
  validated.add(hash);
}
function pump() {
  if (active) return;
  const t = waiting.shift();
  if (!t) return;
  active = true;
  clearTimeout(t.timer);
  t.signal?.removeEventListener("abort", t.abort!);
  t.start();
}
/** One shared process-local slot for topology, model and export work. No unbounded request workers. */
function run<T>(payload: unknown, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted)
    return Promise.reject(
      new ApiError(409, "FLOOD_CANCELLED", "Flood processing was cancelled."),
    );
  if (active && waiting.length >= FLOOD_WORKER_LIMITS.waiting)
    return Promise.reject(
      new ApiError(
        503,
        "FLOOD_WORKER_BUSY",
        "Flood processing capacity is occupied. Retry after current work finishes.",
      ),
    );
  try {
    const data = payload as { kind: string; responses?: FloodResponse[] };
    const bytes =
      data.kind === "normalize"
        ? Buffer.byteLength(
            JSON.stringify({
              ...data,
              responses: data.responses?.map((r) => r.receipt),
            }),
          ) + (data.responses ?? []).reduce((n, r) => n + r.body.byteLength, 0)
        : Buffer.byteLength(JSON.stringify(payload));
    if (bytes > FLOOD_WORKER_LIMITS.inputBytes)
      return Promise.reject(
        new ApiError(
          413,
          "FLOOD_WORKER_INPUT_LIMIT",
          "Flood processing input exceeds 160 MiB. No partial input was accepted.",
        ),
      );
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    const task: Task = {
      reject,
      signal,
      timer: setTimeout(() => {
        const i = waiting.indexOf(task);
        if (i >= 0) {
          waiting.splice(i, 1);
          signal?.removeEventListener("abort", task.abort!);
          reject(
            new ApiError(
              503,
              "FLOOD_WORKER_BUSY",
              "Flood processing queue exceeded 30 seconds.",
            ),
          );
        }
      }, FLOOD_WORKER_LIMITS.queueMs),
      start: () => {
        let worker: Worker;
        try {
          const loader = new URL(
            "./index.mjs",
            pathToFileURL(
              createRequire(import.meta.url).resolve("tsx/esm/api"),
            ),
          ).href;
          worker = new Worker(
            `const{parentPort,workerData}=require('node:worker_threads');import(workerData.loader).then(({tsImport})=>tsImport(workerData.module,workerData.parent)).then(({runFloodWorkerTask})=>runFloodWorkerTask(workerData.payload)).then(result=>parentPort.postMessage({ok:true,result}),error=>parentPort.postMessage({ok:false,error:{message:error.message,code:error.code,status:error.statusCode??error.status}}));`,
            {
              eval: true,
              execArgv: [],
              resourceLimits: {
                maxOldGenerationSizeMb: FLOOD_WORKER_LIMITS.oldHeapMiB,
                maxYoungGenerationSizeMb: 32,
                stackSizeMb: 8,
              },
              workerData: {
                loader,
                module: new URL("./flood-worker-task.ts", import.meta.url).href,
                parent: import.meta.url,
                payload,
              },
            },
          );
        } catch (e) {
          active = false;
          pump();
          reject(e as Error);
          return;
        }
        let settled = false;
        const finish = (error?: Error, result?: T) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          void worker.terminate().then(
            () => {
              active = false;
              pump();
              error ? reject(error) : resolve(result!);
            },
            () =>
              reject(
                new ApiError(
                  503,
                  "FLOOD_WORKER_QUARANTINED",
                  "Flood worker termination unconfirmed; process capacity remains quarantined.",
                ),
              ),
          );
        };
        const abort = () =>
          finish(
            new ApiError(
              409,
              "FLOOD_CANCELLED",
              "Flood processing was cancelled.",
            ),
          );
        const timer = setTimeout(
          () =>
            finish(
              new ApiError(
                503,
                "FLOOD_WORKER_TIMEOUT",
                "Flood processing exceeded 60 seconds; no partial result was accepted.",
              ),
            ),
          FLOOD_WORKER_LIMITS.executionMs,
        );
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        worker.on("message", (m) =>
          m.ok
            ? finish(undefined, m.result)
            : finish(
                typeof m.error?.status === "number" &&
                  typeof m.error?.code === "string"
                  ? new ApiError(
                      m.error.status,
                      m.error.code,
                      String(m.error.message),
                    )
                  : new Error(String(m.error?.message)),
              ),
        );
        worker.on("error", (e) => finish(e));
        worker.on("exit", (code) => {
          if (!settled)
            finish(
              new Error(`Flood processing exited without a result (${code}).`),
            );
        });
      },
    };
    task.abort = () => {
      const i = waiting.indexOf(task);
      if (i >= 0) {
        waiting.splice(i, 1);
        clearTimeout(task.timer);
        reject(
          new ApiError(
            409,
            "FLOOD_CANCELLED",
            "Flood processing was cancelled.",
          ),
        );
      }
    };
    waiting.push(task);
    signal?.addEventListener("abort", task.abort, { once: true });
    pump();
  });
}
export async function normalizeFloodInWorker(
  area: StudyAreaGeometry,
  capturedAt: string,
  responses: FloodResponse[],
): Promise<FloodDataset> {
  const dataset = await run<FloodDataset>({
    kind: "normalize",
    area,
    capturedAt,
    responses,
  });
  remember(floodDatasetHashSync(dataset));
  return dataset;
}
export async function validateFloodDatasetsInWorker(
  datasets: FloodDataset[],
  signal?: AbortSignal,
): Promise<void> {
  const unknown = datasets
    .map((dataset) => ({ hash: floodDatasetHashSync(dataset), dataset }))
    .filter((d) => !validated.has(d.hash));
  if (!unknown.length) return;
  const hashes = await run<string[]>(
    { kind: "validate", datasets: unknown },
    signal,
  );
  if (
    hashes.length !== unknown.length ||
    hashes.some((h, i) => h !== unknown[i].hash)
  )
    throw new Error("Flood validation worker returned mismatched identities.");
  for (const hash of hashes) remember(hash);
}
export function calculateFloodImpactInWorker(
  place: Place,
  scenario: Scenario,
  floodDatasets: FloodDatasetCatalog | undefined,
  fiscalStudy?: import("@urban/core").FiscalStudy,
): Promise<ModelResults> {
  return run({
    kind: "model",
    place,
    scenario,
    floodDatasets,
    ...(fiscalStudy ? { fiscalStudy } : {}),
  });
}
export function exportFloodInWorker(
  snapshot: FloodExportSnapshot,
  format: FloodExportFormat,
  records?: FloodExportRecords,
): Promise<Awaited<ReturnType<typeof exportFloodTask>>> {
  return run({ kind: "export", snapshot, format, records });
}
export function prepareFloodGisInWorker(
  input: Parameters<typeof prepareFloodGisTask>[0],
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof prepareFloodGisTask>>> {
  return run({ kind: "gis", input }, signal);
}

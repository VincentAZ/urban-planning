import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { ApiError } from "./errors.js";
import type { prepareGisPreview } from "./gis-import-mapping.js";
import type { GisPreview } from "./gis-jobs-types.js";

/** Geometry mapping/clipping can be CPU-heavy even after native conversion.
 * Keep it off the HTTP event loop, with a hard deadline and a bounded heap.
 * Only this fixed module runs; uploaded files never become code or module paths. */
export async function prepareGisPreviewInWorker(
  input: Parameters<typeof prepareGisPreview>[0],
  options: { signal?: AbortSignal; milliseconds?: number } = {},
): Promise<GisPreview> {
  if (options.signal?.aborted)
    throw new ApiError(409, "GIS_CANCELLED", "GIS mapping was cancelled.");
  const loader = new URL(
    "./index.mjs",
    pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")),
  ).href;
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      `
      const {parentPort,workerData}=require('node:worker_threads');
      import(workerData.loader).then(({tsImport})=>tsImport(workerData.module,workerData.parent))
        .then(({prepareGisPreview})=>prepareGisPreview(workerData.input))
        .then(result=>parentPort.postMessage({ok:true,result}))
        .catch(error=>parentPort.postMessage({ok:false,error:error.name==='ZodError'?{code:'GIS_MAPPING_INVALID',statusCode:422,message:error.issues.map(issue=>issue.path.join('.')+': '+issue.message).join('; ').slice(0,4000)}:{code:error.code,statusCode:error.statusCode,message:error.message}}));
    `,
      {
        eval: true,
        execArgv: [],
        resourceLimits: {
          maxOldGenerationSizeMb: 512,
          maxYoungGenerationSizeMb: 32,
          stackSizeMb: 8,
        },
        workerData: {
          loader,
          module: new URL("./gis-import-mapping.ts", import.meta.url).href,
          parent: import.meta.url,
          input,
        },
      },
    );
    let settled = false;
    const finish = (error?: Error, result?: GisPreview) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      void worker.terminate().then(
        () => {
          if (error) reject(error);
          else resolve(result!);
        },
        () =>
          reject(
            new ApiError(
              503,
              "NATIVE_CLEANUP_UNCONFIRMED",
              "The geometry worker may still be running. Shared capacity requires confirmed termination before reuse.",
            ),
          ),
      );
    };
    const abort = () =>
      finish(
        new ApiError(
          409,
          "GIS_CANCELLED",
          "GIS mapping was cancelled; no partial layer was accepted.",
        ),
      );
    const timer = setTimeout(
      () =>
        finish(
          new ApiError(
            413,
            "GIS_MAPPING_TIMEOUT",
            "Geometry mapping exceeded 15 seconds. Split the file into smaller batches; no partial layer was accepted.",
          ),
        ),
      Math.min(options.milliseconds ?? 15000, 15000),
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.on("message", (message) => {
      if (message.ok) finish(undefined, message.result);
      else if (
        typeof message.error?.code === "string" &&
        Number.isInteger(message.error.statusCode)
      )
        finish(
          new ApiError(
            message.error.statusCode,
            message.error.code,
            message.error.message,
          ),
        );
      else
        finish(
          new ApiError(
            503,
            "GIS_MAPPING_FAILED",
            "The bounded geometry worker could not load or validate its inputs. No partial layer was accepted.",
          ),
        );
    });
    worker.on("error", () =>
      finish(
        new ApiError(
          503,
          "GIS_MAPPING_FAILED",
          "The bounded geometry worker failed or exhausted its memory. No partial layer was accepted.",
        ),
      ),
    );
    worker.on("exit", () => {
      if (!settled)
        finish(
          new ApiError(
            503,
            "GIS_MAPPING_FAILED",
            "The geometry worker stopped before producing a complete preview.",
          ),
        );
    });
  });
}

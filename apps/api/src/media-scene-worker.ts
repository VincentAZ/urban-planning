import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { ApiError } from "./errors.js";
import type { prepareMediaScene } from "./media-scene-task.js";
import type { MediaScene } from "@urban/core";
let active = false;

/** Scene preparation/clipping can be CPU-heavy even after native conversion.
 * Keep it off the HTTP event loop, with a hard deadline and a bounded heap.
 * Only this fixed module runs; uploaded files never become code or module paths. */
export async function prepareMediaSceneInWorker(
  input: Parameters<typeof prepareMediaScene>[0],
  options: { signal?: AbortSignal; milliseconds?: number } = {},
): Promise<MediaScene> {
  if (options.signal?.aborted)
    throw new ApiError(409, "MEDIA_CANCELLED", "Media preview was cancelled.");
  if (active)
    throw new ApiError(
      429,
      "MEDIA_PREVIEW_BUSY",
      "A media preview is being prepared. Try again shortly.",
    );
  if (Buffer.byteLength(JSON.stringify(input)) > 32 * 1024 ** 2)
    throw new ApiError(
      413,
      "MEDIA_SCENE_TOO_LARGE",
      "The complete media scene exceeds 32 MiB.",
    );
  active = true;
  try {
    const loader = new URL(
      "./index.mjs",
      pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")),
    ).href;
    return await new Promise((resolve, reject) => {
      const worker = new Worker(
        `
      const {parentPort,workerData}=require('node:worker_threads');
      import(workerData.loader).then(({tsImport})=>tsImport(workerData.module,workerData.parent))
        .then(({prepareMediaScene})=>prepareMediaScene(workerData.input))
        .then(result=>parentPort.postMessage({ok:true,result}))
        .catch(error=>parentPort.postMessage({ok:false,error:error.name==='ZodError'?{code:'MEDIA_SCENE_INVALID',statusCode:422,message:error.issues.map(issue=>issue.path.join('.')+': '+issue.message).join('; ').slice(0,4000)}:{code:error.code,statusCode:error.statusCode,message:error.message}}));
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
            module: new URL("./media-scene-task.ts", import.meta.url).href,
            parent: import.meta.url,
            input,
          },
        },
      );
      let settled = false;
      const finish = (error?: Error, result?: MediaScene) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        void worker.terminate().then(
          () => {
            active = false;
            if (error) reject(error);
            else resolve(result!);
          },
          () =>
            reject(
              new ApiError(
                503,
                "NATIVE_CLEANUP_UNCONFIRMED",
                "The scene worker may still be running. Preview preparation remains quarantined until process termination is confirmed.",
              ),
            ),
        );
      };
      const abort = () =>
        finish(
          new ApiError(
            409,
            "MEDIA_CANCELLED",
            "Media preview was cancelled; no partial scene was accepted.",
          ),
        );
      const timer = setTimeout(
        () =>
          finish(
            new ApiError(
              413,
              "MEDIA_SCENE_TIMEOUT",
              "Scene preparation exceeded 60 seconds. Reduce the scene complexity before preparing another export; no geometry was dropped.",
            ),
          ),
        Math.min(options.milliseconds ?? 60000, 60000),
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
              "MEDIA_SCENE_FAILED",
              "The bounded scene worker could not load or validate its inputs. No partial layer was accepted.",
            ),
          );
      });
      worker.on("error", () =>
        finish(
          new ApiError(
            503,
            "MEDIA_SCENE_FAILED",
            "The bounded scene worker failed or exhausted its memory. No partial layer was accepted.",
          ),
        ),
      );
      worker.on("exit", () => {
        if (!settled)
          finish(
            new ApiError(
              503,
              "MEDIA_SCENE_FAILED",
              "The scene worker stopped before producing a complete preview.",
            ),
          );
      });
    });
  } catch (error) {
    if (
      !(
        error instanceof ApiError && error.code === "NATIVE_CLEANUP_UNCONFIRMED"
      )
    )
      active = false;
    throw error;
  }
}

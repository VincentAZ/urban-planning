import type { MediaCapacityDeclaration } from "./media-types.js";
import { resolve } from "node:path";
import type { Store } from "./store.js";
import { MediaJobService } from "./media-jobs.js";
import { MediaRuntime } from "./media-runtime.js";
/** Parsing only: no image download, provider request or process launch during application construction. */
export function mediaServiceFromEnvironment(
  store: Store,
  env: NodeJS.ProcessEnv = process.env,
): MediaJobService {
  const environment = env.MEDIA_CAPACITY_ENVIRONMENT,
    statement = env.MEDIA_CAPACITY_STATEMENT;
  const capacity: MediaCapacityDeclaration | undefined =
    (environment === "local-development" || environment === "deployment") &&
    statement &&
    statement.trim().length >= 12
      ? {
          mode: "fixed-capacity" as const,
          environment,
          statement: statement.trim(),
        }
      : undefined;
  const enabled = env.MEDIA_ENABLED === "true";
  const validImage = /^sha256:[a-f0-9]{64}$/.test(env.MEDIA_IMAGE_ID ?? "");
  const configurationReason =
    enabled && env.MEDIA_IMAGE_ID && !validImage
      ? "Media rendering is unavailable: configure MEDIA_IMAGE_ID with an installed immutable sha256 image ID."
      : undefined;
  const executor =
    enabled && validImage && env.MEDIA_IMAGE_ID && env.MEDIA_RENDERER_DIRECTORY
      ? new MediaRuntime({
          image: env.MEDIA_IMAGE_ID,
          rendererDirectory: resolve(env.MEDIA_RENDERER_DIRECTORY),
          workRoot: resolve(env.MEDIA_WORK_ROOT ?? ".local/media/work"),
        })
      : undefined;
  return new MediaJobService(store, {
    enabled,
    configurationReason,
    executor,
    capacity,
    archiveDirectory: resolve(
      env.MEDIA_ARCHIVE_DIRECTORY ?? ".local/media/private-archive",
    ),
  });
}

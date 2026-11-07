import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJSON,
  prepareMediaTimeline,
  assertMediaFrameReceipts,
  mediaContentHash,
  mediaTranscript,
  mediaWebVtt,
  MEDIA_METHOD_VERSION,
  MEDIA_HOLD_REUSE_NOTE,
  type MediaExportManifest,
  type MediaFrameReceipt,
} from "@urban/core";
import { ApiError } from "./errors.js";
import { confirmDockerContainerAbsent } from "./native-process.js";
import type {
  MediaExecutor,
  MediaExecutionResult,
  MediaRuntimeIdentity,
} from "./media-types.js";

export const MEDIA_RUNTIME_PROFILE = "citymap-media-runtime-1.0.0";
export const MEDIA_RUNTIME_LIMITS = {
  milliseconds: 15 * 60 * 1000,
  memoryBytes: 2 * 1024 ** 3,
  outputBytes: 192 * 1024 ** 2,
  receiptBytes: 32 * 1024 ** 2,
  rendererBytes: 128 * 1024 ** 2,
  assetBytes: 32 * 1024 ** 2,
} as const;
const sha = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
const error = (code: string, message: string, status = 422) =>
  new ApiError(status, code, message);
interface RendererProfile {
  version: 1;
  profileVersion: string;
  entry: string;
  rendererHash: string;
  files: { path: string; bytes: number; sha256: string }[];
}
async function bounded(path: string, cap: number) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > cap)
    throw error(
      "MEDIA_FILE_INVALID",
      "A media file is missing, nonregular or exceeds its byte limit.",
    );
  const bytes = await readFile(path);
  if (bytes.length !== metadata.size || bytes.length > cap)
    throw error(
      "MEDIA_FILE_CHANGED",
      "A media file changed during verification.",
    );
  return bytes;
}
async function command(
  args: string[],
  milliseconds: number,
  options: {
    signal?: AbortSignal;
    container?: string;
    progress?: (
      stage: "rendering" | "encoding" | "verifying",
      frames: number,
    ) => Promise<void>;
  } = {},
) {
  if (options.signal?.aborted)
    throw error("MEDIA_CANCELLED", "The export was cancelled.", 409);
  return new Promise<{ code: number; output: string }>(
    (resolveResult, reject) => {
      const child = spawn("docker", args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let bytes = 0,
        output = "",
        line = "",
        stopped: string | undefined,
        cleanupPromise: Promise<unknown> | undefined,
        progress = Promise.resolve();
      let notifyStopped!: () => void;
      const stoppedSignal = new Promise<void>((resolve) => {
        notifyStopped = resolve;
      });
      const stop = (reason: string) => {
        if (stopped) return;
        stopped = reason;
        notifyStopped();
        if (options.container)
          cleanupPromise = command(
            ["rm", "--force", options.container],
            5000,
          ).catch(() => {});
        child.kill("SIGKILL");
      };
      const consume = (chunk: Buffer, stdout: boolean) => {
        bytes += chunk.length;
        if (bytes > 256 * 1024) {
          stop("MEDIA_OUTPUT_LIMIT");
          return;
        }
        output += chunk.toString("utf8");
        if (stdout && options.progress) {
          line += chunk.toString("utf8");
          let end;
          while ((end = line.indexOf("\n")) >= 0) {
            const row = line.slice(0, end);
            line = line.slice(end + 1);
            try {
              const event = JSON.parse(row);
              if (
                !["rendering", "encoding", "verifying"].includes(event.stage) ||
                !Number.isInteger(event.completedFrames) ||
                event.completedFrames < 0 ||
                event.completedFrames > 30000
              )
                throw new Error();
              progress = progress
                .then(() =>
                  stopped
                    ? undefined
                    : options.progress!(event.stage, event.completedFrames),
                )
                .catch(() => {
                  stop("MEDIA_PROGRESS_FAILED");
                });
            } catch {
              stop("MEDIA_PROGRESS_INVALID");
            }
          }
        }
      };
      child.stdout.on("data", (chunk) => consume(chunk, true));
      child.stderr.on("data", (chunk) => consume(chunk, false));
      const timer = setTimeout(() => stop("MEDIA_TIMEOUT"), milliseconds);
      const abort = () => stop("MEDIA_CANCELLED");
      options.signal?.addEventListener("abort", abort, { once: true });
      const done = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      };
      child.once("error", () => {
        done();
        reject(
          error(
            "MEDIA_RUNTIME_UNAVAILABLE",
            "The installed media container runtime is unavailable.",
            503,
          ),
        );
      });
      child.once("close", async (code) => {
        // A closed container is not permission to wait forever for a database callback.
        // Keep cancellation and the run deadline alive through progress reconciliation.
        await Promise.race([progress, stoppedSignal]);
        await cleanupPromise;
        done();
        if (stopped)
          reject(
            error(
              stopped,
              stopped === "MEDIA_CANCELLED"
                ? "The export was cancelled."
                : "The bounded media renderer stopped before completion. No partial artifact was accepted.",
              stopped === "MEDIA_CANCELLED" ? 409 : 503,
            ),
          );
        else resolveResult({ code: code ?? -1, output });
      });
    },
  );
}

/** Only trusted server paths and an immutable locally installed image ID are configurable. */
export class MediaRuntime implements MediaExecutor {
  private active = false;
  constructor(
    readonly options: {
      image: string;
      rendererDirectory: string;
      workRoot: string;
      workerPath?: string;
    },
  ) {
    if (!/^sha256:[a-f0-9]{64}$/.test(options.image))
      throw error(
        "MEDIA_IMAGE_UNPINNED",
        "Install and configure an immutable media image ID.",
        503,
      );
  }
  private workerPath() {
    return (
      this.options.workerPath ??
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../scripts/media/worker.mjs",
      )
    );
  }
  private async profile() {
    const root = await realpath(this.options.rendererDirectory);
    const profile = JSON.parse(
      (
        await bounded(join(root, "renderer-manifest.json"), 1024 * 1024)
      ).toString(),
    ) as RendererProfile;
    const { rendererHash, ...identity } = profile;
    if (
      profile.version !== 1 ||
      profile.profileVersion !== "citymap-media-1.0.0" ||
      profile.entry !== "media-render.html" ||
      sha(canonicalJSON(identity)) !== rendererHash ||
      !Array.isArray(profile.files) ||
      !profile.files.length ||
      profile.files.length > 256 ||
      new Set(profile.files.map((f) => f.path)).size !== profile.files.length
    )
      throw error(
        "MEDIA_RENDERER_INVALID",
        "The media renderer inventory is invalid.",
        503,
      );
    let total = 0;
    for (const file of profile.files) {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(file.path) ||
        file.path.includes("..") ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 1 ||
        file.bytes > MEDIA_RUNTIME_LIMITS.assetBytes ||
        !/^[a-f0-9]{64}$/.test(file.sha256)
      )
        throw error(
          "MEDIA_RENDERER_INVALID",
          "A renderer asset identity is invalid.",
          503,
        );
      total += file.bytes;
      if (total > MEDIA_RUNTIME_LIMITS.rendererBytes)
        throw error(
          "MEDIA_RENDERER_INVALID",
          "The complete renderer exceeds its asset limit.",
          503,
        );
      const bytes = await bounded(
        join(root, file.path),
        MEDIA_RUNTIME_LIMITS.assetBytes,
      );
      if (bytes.length !== file.bytes || sha(bytes) !== file.sha256)
        throw error(
          "MEDIA_RENDERER_CHANGED",
          "A renderer asset changed after its build.",
          503,
        );
    }
    if (
      !profile.files.some((f) => f.path === profile.entry) ||
      !profile.files.some((f) => /\.ttf$/.test(f.path))
    )
      throw error(
        "MEDIA_RENDERER_INVALID",
        "The renderer entry and pinned fonts are required.",
        503,
      );
    return { root, profile };
  }
  private async schedulerIdentity() {
    const directory = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../packages/core/src",
    );
    const modules = await Promise.all(
      ["media.ts", "media-timeline.ts", "canonical.ts"].map(async (name) => ({
        name,
        sha256: sha(await bounded(join(directory, name), 1024 * 1024)),
      })),
    );
    return {
      node: process.version,
      v8: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
      modules,
    };
  }
  async identity(): Promise<MediaRuntimeIdentity> {
    const { profile } = await this.profile();
    const native = await command(
      ["image", "inspect", "--format", "{{.Id}}", this.options.image],
      5000,
    );
    if (native.code !== 0 || native.output.trim() !== this.options.image)
      throw error(
        "MEDIA_RUNTIME_UNAVAILABLE",
        "The configured immutable media image is not installed.",
        503,
      );
    const workerHash = sha(await bounded(this.workerPath(), 1024 * 1024));
    return {
      profileVersion: MEDIA_RUNTIME_PROFILE,
      rendererHash: profile.rendererHash,
      runtimeHash: mediaContentHash({
        profileVersion: MEDIA_RUNTIME_PROFILE,
        image: this.options.image,
        workerHash,
        limits: MEDIA_RUNTIME_LIMITS,
        scheduler: await this.schedulerIdentity(),
      }),
    };
  }
  async execute(
    input: Parameters<MediaExecutor["execute"]>[0],
  ): Promise<MediaExecutionResult> {
    if (this.active)
      throw error(
        "MEDIA_RUNTIME_BUSY",
        "The local media runtime is processing another export.",
        503,
      );
    this.active = true;
    let job: string | undefined,
      created = false,
      confirmed = true;
    const container = `urban-media-${randomUUID()}`;
    try {
      const uid = process.getuid?.() ?? 0,
        gid = process.getgid?.() ?? 0;
      if (!uid)
        throw error(
          "MEDIA_NONROOT_REQUIRED",
          "Run the media adapter under a nonroot service account.",
          503,
        );
      const timeline = prepareMediaTimeline(input.scene, input.recipe);
      const identity = await this.identity(),
        { root, profile } = await this.profile();
      if (
        canonicalJSON(identity) !== canonicalJSON(input.runtimeIdentity) ||
        identity.rendererHash !== profile.rendererHash
      )
        throw error(
          "MEDIA_RENDERER_CHANGED",
          "The renderer changed during admission.",
          409,
        );
      const workRoot = resolve(this.options.workRoot);
      await mkdir(workRoot, { recursive: true, mode: 0o700 });
      job = await mkdtemp(join(workRoot, "job-"));
      if (/[\r\n,]/.test(job))
        throw error(
          "MEDIA_WORK_PATH_INVALID",
          "Use a private work directory without Docker mount separators.",
          503,
        );
      const incoming = join(job, "input"),
        outgoing = join(job, "output"),
        renderer = join(job, "renderer");
      for (const directory of [incoming, outgoing, renderer])
        await mkdir(directory, { mode: 0o700 });
      for (const file of profile.files) {
        const bytes = await bounded(
          join(root, file.path),
          MEDIA_RUNTIME_LIMITS.assetBytes,
        );
        if (sha(bytes) !== file.sha256)
          throw error(
            "MEDIA_RENDERER_CHANGED",
            "A renderer asset changed while freezing the job.",
            409,
          );
        await mkdir(dirname(join(renderer, file.path)), {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(join(renderer, file.path), bytes, {
          flag: "wx",
          mode: 0o400,
        });
      }
      await writeFile(
        join(renderer, "renderer-manifest.json"),
        canonicalJSON(profile),
        { flag: "wx", mode: 0o400 },
      );
      const worker = await bounded(this.workerPath(), 1024 * 1024);
      const runtimeHash = mediaContentHash({
        profileVersion: MEDIA_RUNTIME_PROFILE,
        image: this.options.image,
        workerHash: sha(worker),
        limits: MEDIA_RUNTIME_LIMITS,
        scheduler: await this.schedulerIdentity(),
      });
      if (runtimeHash !== identity.runtimeHash)
        throw error(
          "MEDIA_RUNTIME_CHANGED",
          "The media worker changed during admission.",
          409,
        );
      await writeFile(join(incoming, "worker.mjs"), worker, {
        flag: "wx",
        mode: 0o400,
      });
      const request = canonicalJSON({
        scene: input.scene,
        recipe: input.recipe,
        frameCount: timeline.frameCount,
        scheduledCameras: Array.from(
          { length: timeline.frameCount },
          (_, index) => timeline.frameAt(index).camera,
        ),
        runtimeIdentity: identity,
      });
      if (Buffer.byteLength(request) > 40 * 1024 ** 2)
        throw error(
          "MEDIA_INPUT_TOO_LARGE",
          "The complete frozen export exceeds its input limit.",
          413,
        );
      await writeFile(join(incoming, "request.json"), request, {
        flag: "wx",
        mode: 0o400,
      });
      created = true;
      confirmed = false;
      const made = await command(
        [
          "create",
          "--rm",
          "--pull=never",
          "--name",
          container,
          "--label",
          "urban-planning.service=media",
          "--network=none",
          "--read-only",
          "--user",
          `${uid}:${gid}`,
          "--cap-drop=ALL",
          "--security-opt",
          "no-new-privileges",
          "--memory",
          String(MEDIA_RUNTIME_LIMITS.memoryBytes),
          "--memory-swap",
          String(MEDIA_RUNTIME_LIMITS.memoryBytes),
          "--cpus=2",
          "--pids-limit=256",
          "--ulimit",
          "nofile=1024:1024",
          "--ulimit",
          `fsize=${MEDIA_RUNTIME_LIMITS.outputBytes}:${MEDIA_RUNTIME_LIMITS.outputBytes}`,
          "--tmpfs",
          `/tmp:rw,nosuid,nodev,size=768m,uid=${uid},gid=${gid},mode=700`,
          "--mount",
          `type=bind,src=${incoming},dst=/input,readonly`,
          "--mount",
          `type=bind,src=${outgoing},dst=/out`,
          "--mount",
          `type=bind,src=${renderer},dst=/renderer,readonly`,
          "--mount",
          `type=bind,src=${join(incoming, "worker.mjs")},dst=/opt/urban-media/worker.mjs,readonly`,
          "--env",
          "HOME=/tmp",
          "--entrypoint",
          "node",
          this.options.image,
          "/opt/urban-media/worker.mjs",
        ],
        5000,
      );
      if (made.code !== 0)
        throw error(
          "MEDIA_RUNTIME_UNAVAILABLE",
          "The isolated media container could not be created.",
          503,
        );
      const native = await command(
        ["start", "--attach", container],
        MEDIA_RUNTIME_LIMITS.milliseconds,
        {
          signal: input.signal,
          container,
          progress: (stage, frames) => input.onProgress(stage, frames),
        },
      );
      await confirmDockerContainerAbsent(container);
      confirmed = true;
      const result = JSON.parse(
        (
          await bounded(join(outgoing, "response.json"), 1024 * 1024)
        ).toString(),
      );
      if (native.code !== 0 || !result.ok)
        throw error(
          /^MEDIA_[A-Z_]+$/.test(result.error?.code ?? "")
            ? result.error.code
            : "MEDIA_RENDERER_FAILED",
          result.error?.code?.startsWith("MEDIA_")
            ? result.error.message
            : "The isolated media renderer did not complete. No partial output was accepted.",
        );
      if (
        result.frameCount !== timeline.frameCount ||
        result.width !== input.recipe.width ||
        result.height !== input.recipe.height
      )
        throw error(
          "MEDIA_OUTPUT_MISMATCH",
          "The completed media identity changed.",
        );
      const receiptsBytes = await bounded(
        join(outgoing, "frames.json"),
        MEDIA_RUNTIME_LIMITS.receiptBytes,
      );
      const receipts = JSON.parse(
        receiptsBytes.toString(),
      ) as MediaFrameReceipt[];
      assertMediaFrameReceipts(timeline, receipts);
      const main = input.recipe.format === "png" ? "output.png" : "output.mp4";
      const files: Record<string, Uint8Array> = {
        [main]: await bounded(
          join(outgoing, main),
          MEDIA_RUNTIME_LIMITS.outputBytes,
        ),
        "frames.json": receiptsBytes,
        "transcript.txt": Buffer.from(
          mediaTranscript(input.scene, input.recipe),
        ),
        "captions.vtt": Buffer.from(mediaWebVtt(input.scene, input.recipe)),
      };
      const contentTypes: Record<string, string> = {
        [main]: input.recipe.format === "png" ? "image/png" : "video/mp4",
        "frames.json": "application/json",
        "transcript.txt": "text/plain; charset=utf-8",
        "captions.vtt": "text/vtt; charset=utf-8",
        "manifest.json": "application/json",
      };
      if (input.recipe.format === "mp4") {
        files["thumbnail.png"] = await bounded(
          join(outgoing, "thumbnail.png"),
          32 * 1024 ** 2,
        );
        contentTypes["thumbnail.png"] = "image/png";
      }
      const firstImage = Buffer.from(
        files[input.recipe.format === "png" ? "output.png" : "thumbnail.png"],
      );
      if (
        firstImage.length < 24 ||
        firstImage.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
        firstImage.readUInt32BE(16) !== input.recipe.width ||
        firstImage.readUInt32BE(20) !== input.recipe.height ||
        sha(firstImage) !== receipts[0].pixelHash
      )
        throw error(
          "MEDIA_IMAGE_MISMATCH",
          "The retained first image does not match its captured frame receipt.",
        );
      const manifest: MediaExportManifest = {
        version: 1,
        methodVersion: MEDIA_METHOD_VERSION,
        sceneHash: input.scene.sceneHash,
        binding: input.scene.binding,
        recipe: input.recipe,
        recipeHash: mediaContentHash(input.recipe),
        frameCount: timeline.frameCount,
        duration: timeline.duration,
        layout: timeline.layout,
        frameReceiptsHash: sha(receiptsBytes),
        runtime: {
          profileVersion: identity.profileVersion,
          hash: identity.runtimeHash,
        },
        renderer: {
          name: "CityMap / Chromium",
          version: String(result.chromium),
          profileHash: identity.rendererHash,
          fontHashes: profile.files
            .filter((f) => /\.ttf$/.test(f.path))
            .map((f) => f.sha256)
            .sort(),
        },
        encoder:
          input.recipe.format === "mp4"
            ? {
                name: "FFmpeg / libx264",
                version: String(result.ffmpeg),
                profileHash: identity.runtimeHash,
              }
            : null,
        files: Object.entries(files).map(([name, body]) => ({
          name,
          bytes: body.byteLength,
          sha256: sha(Buffer.from(body)),
          contentType: contentTypes[name],
        })),
        sources: input.scene.sources,
        notes: [
          "Private export of one immutable saved scene; author statements and illustrative geometry are not independent predictions.",
          "Captions have no narration audio. Complete authored callouts, narration, metrics and sources accompany the media.",
          "Default vector rendering makes no external imagery requests. Captured imagery exports are unavailable.",
          MEDIA_HOLD_REUSE_NOTE,
          "Each frame pixelHash identifies exact captured PNG bytes before H.264 encoding; MP4 uses lossy compression.",
          "Renderer, fonts, runtime and exact input are identified; pixel identity across different hardware is not promised.",
          `Installed runtime image ${this.options.image}; worker SHA-256 ${sha(worker)}.`,
          `The host camera scheduler uses Node ${process.version}, V8 ${process.versions.v8}, ${process.platform}/${process.arch}. Host scheduler code and versions are bound into the runtime hash; exact requested cameras are retained in frames.json.`,
        ],
      };
      files["manifest.json"] = Buffer.from(canonicalJSON(manifest));
      const bytes = Object.values(files).reduce((n, b) => n + b.byteLength, 0);
      if (bytes > 224 * 1024 ** 2)
        throw error(
          "MEDIA_OUTPUT_TOO_LARGE",
          "The complete media export exceeds its archive allowance.",
          413,
        );
      return { files, contentTypes };
    } finally {
      if (created && !confirmed) {
        await command(["rm", "--force", container], 5000).catch(() => {});
        await confirmDockerContainerAbsent(container);
        confirmed = true;
      }
      if (job && confirmed) await rm(job, { recursive: true, force: true });
      this.active = false;
    }
  }
}

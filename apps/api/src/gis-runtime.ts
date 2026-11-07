import { confirmDockerContainerAbsent } from "./native-process.js";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJSON, sourceImportMetadataSchema } from "@urban/core";
import { ApiError } from "./errors.js";
import {
  GIS_IMAGE,
  GIS_LIMITS,
  gisRecipeSchema,
  type GisExportLayer,
  type GisExportResult,
  type GisInput,
  type GisInspection,
  type GisNormalized,
  type GisRecipe,
} from "./gis-types.js";

export class GisError extends ApiError {
  constructor(
    code: string,
    message: string,
    status = code.includes("LIMIT") || code === "GIS_TOO_LARGE" ? 413 : 422,
  ) {
    super(status, code, message);
  }
}
const sha = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
const inside = (root: string, path: string) => {
  const part = relative(root, path);
  return (
    part === "" ||
    (!part.startsWith(`..${sep}`) && part !== ".." && !part.startsWith(sep))
  );
};
async function bounded(path: string, cap: number) {
  const s = await stat(path);
  if (!s.isFile() || s.size > cap)
    throw new GisError(
      "GIS_TOO_LARGE",
      "The GIS file exceeds its configured byte limit.",
    );
  const data = await readFile(path);
  if (data.length > cap)
    throw new GisError(
      "GIS_TOO_LARGE",
      "The GIS file grew beyond its configured byte limit.",
    );
  return data;
}
async function docker(
  args: string[],
  milliseconds: number,
  signal?: AbortSignal,
  container?: string,
) {
  if (signal?.aborted)
    throw new GisError("GIS_CANCELLED", "GIS processing was cancelled.", 409);
  return new Promise<{ code: number; output: string }>(
    (resolveResult, reject) => {
      const process = spawn("docker", args, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      let output = "",
        bytes = 0,
        stopped: "timeout" | "cancelled" | "output" | undefined;
      let killing: Promise<unknown> | undefined;
      const stop = (reason: typeof stopped) => {
        if (stopped) return;
        stopped = reason;
        if (container)
          killing = docker(["rm", "--force", container], 5000).catch(() => {});
        process.kill("SIGKILL");
      };
      const consume = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 256 * 1024) stop("output");
        else output += chunk.toString("utf8");
      };
      process.stdout.on("data", consume);
      process.stderr.on("data", consume);
      const timer = setTimeout(() => stop("timeout"), milliseconds);
      const abort = () => stop("cancelled");
      signal?.addEventListener("abort", abort, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      process.on("error", () => {
        cleanup();
        reject(
          new GisError(
            "GIS_RUNTIME_UNAVAILABLE",
            "The configured GIS container runtime is unavailable.",
            503,
          ),
        );
      });
      process.on("close", async (code) => {
        cleanup();
        await killing;
        if (stopped)
          reject(
            new GisError(
              stopped === "cancelled"
                ? "GIS_CANCELLED"
                : stopped === "timeout"
                  ? "GIS_TIMEOUT"
                  : "GIS_OUTPUT_LIMIT",
              stopped === "cancelled"
                ? "GIS processing was cancelled."
                : "GIS processing exceeded its bounded runtime or output limit; no partial layer was accepted.",
              stopped === "cancelled" ? 409 : 413,
            ),
          );
        else resolveResult({ code: code ?? -1, output });
      });
    },
  );
}

/** No durable queue or credentials. Call only with paths in a trusted private upload root. */
export class GisRuntime {
  readonly image: string;
  private active = false;
  constructor(
    readonly options: {
      workRoot: string;
      allowedInputRoot: string;
      image?: string;
    },
  ) {
    this.image = options.image ?? GIS_IMAGE;
    if (this.image !== GIS_IMAGE)
      throw new GisError(
        "GIS_IMAGE_UNSUPPORTED",
        "Configure the verified pinned GIS image digest.",
        503,
      );
  }
  async available() {
    const result = await docker(
      ["image", "inspect", "--format", "{{.Id}}", this.image],
      5000,
    );
    return {
      available: result.code === 0,
      image: this.image,
      reason:
        result.code === 0
          ? null
          : "The pinned offline GIS image has not been installed by the operator.",
    };
  }
  private async run(
    operation: "inspect" | "normalize" | "export",
    input?: GisInput,
    extra: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<{ result: unknown; zip?: Buffer }> {
    if (this.active)
      throw new GisError(
        "GIS_BUSY",
        "The GIS converter is processing another bounded operation. Retry after it finishes.",
        503,
      );
    this.active = true;
    let job: string | undefined;
    const container = `urban-gis-${randomUUID()}`;
    try {
      const uid = process.getuid?.() ?? 0,
        gid = process.getgid?.() ?? 0;
      if (!uid)
        throw new GisError(
          "GIS_NONROOT_REQUIRED",
          "Run the GIS adapter under a nonroot service account.",
          503,
        );
      const root = resolve(this.options.workRoot);
      await mkdir(root, { recursive: true, mode: 0o700 });
      job = await mkdtemp(join(root, "job-"));
      const incoming = join(job, "input"),
        outgoing = join(job, "output");
      await mkdir(incoming, { mode: 0o700 });
      await mkdir(outgoing, { mode: 0o700 });
      if (input) {
        const [allowed, actual] = await Promise.all([
          realpath(this.options.allowedInputRoot),
          realpath(input.inputPath),
        ]);
        if (!inside(allowed, actual))
          throw new GisError(
            "GIS_INPUT_PATH",
            "The input is outside the configured private upload root.",
            403,
          );
        const bytes = await bounded(actual, GIS_LIMITS.inputBytes);
        await writeFile(join(incoming, "source"), bytes, {
          mode: 0o400,
          flag: "wx",
        });
      }
      const filename = input?.filename ?? `source.${input?.format ?? "json"}`;
      if (
        !/^[^/\\\x00:]{1,240}$/.test(filename) ||
        [".", ".."].includes(filename)
      )
        throw new GisError(
          "GIS_FILENAME",
          "Use a bounded display filename without a filesystem path.",
        );
      const request = {
        operation,
        ...(input ? { format: input.format, filename } : {}),
        imageDigest: this.image.split("@")[1],
        ...extra,
      };
      const serialized = JSON.stringify(request);
      if (Buffer.byteLength(serialized) > GIS_LIMITS.expandedBytes)
        throw new GisError(
          "GIS_TOO_LARGE",
          "The converter request exceeds 100 MiB.",
        );
      await writeFile(join(incoming, "request.json"), serialized, {
        mode: 0o400,
        flag: "wx",
      });
      const script = await realpath(
        resolve(
          dirname(fileURLToPath(import.meta.url)),
          "../../../scripts/gis-worker.py",
        ),
      );
      const created = await docker(
        [
          "create",
          "--rm",
          "--pull=never",
          "--name",
          container,
          "--label",
          "urban-planning.service=gis",
          "--network=none",
          "--read-only",
          "--user",
          `${uid}:${gid}`,
          "--cap-drop=ALL",
          "--security-opt",
          "no-new-privileges",
          "--memory",
          String(GIS_LIMITS.memoryBytes),
          "--memory-swap",
          String(GIS_LIMITS.memoryBytes),
          "--cpus=1",
          "--pids-limit=64",
          "--ulimit",
          "cpu=30:30",
          "--ulimit",
          "nofile=128:128",
          "--tmpfs",
          `/tmp:rw,nosuid,nodev,noexec,size=128m,uid=${uid},gid=${gid},mode=700`,
          "--mount",
          `type=bind,src=${incoming},dst=/input,readonly`,
          "--mount",
          `type=bind,src=${outgoing},dst=/out`,
          "--mount",
          `type=bind,src=${script},dst=/worker.py,readonly`,
          "--env",
          "PROJ_NETWORK=OFF",
          "--entrypoint",
          "python3",
          this.image,
          "/worker.py",
        ],
        5000,
      );
      if (created.code !== 0)
        throw new GisError(
          "GIS_RUNTIME_UNAVAILABLE",
          "The isolated GIS container could not be created from the installed image.",
          503,
        );
      const native = await docker(
        ["start", "--attach", container],
        GIS_LIMITS.milliseconds,
        signal ?? input?.signal,
        container,
      );
      if (native.code !== 0)
        throw new GisError(
          "GIS_NATIVE_FAILED",
          "The isolated GIS converter failed or exceeded its resource limits. No partial output was accepted.",
          422,
        );
      const response = JSON.parse(
        (
          await bounded(join(outgoing, "response.json"), GIS_LIMITS.outputBytes)
        ).toString("utf8"),
      );
      if (!response.ok)
        throw new GisError(
          response.error?.code ?? "GIS_CONVERSION_FAILED",
          response.error?.message ?? "The GIS source could not be converted.",
        );
      if (operation === "export") {
        const zip = await bounded(
          join(outgoing, "export.zip"),
          GIS_LIMITS.outputBytes,
        );
        if (
          sha(zip) !== response.result.sha256 ||
          zip.length !== response.result.bytes
        )
          throw new GisError(
            "GIS_ARTIFACT_MISMATCH",
            "The generated archive does not match its recorded identity.",
          );
        return { result: response.result, zip };
      }
      return { result: response.result };
    } finally {
      // Covers normal completion, abort, timeout and failed docker startup.
      try {
        await docker(["rm", "--force", container], 5000).catch(() => {});
        await confirmDockerContainerAbsent(container);
      } finally {
        if (job) await rm(job, { recursive: true, force: true });
        this.active = false;
      }
    }
  }
  async inspect(input: GisInput): Promise<GisInspection> {
    const result = (await this.run("inspect", input)).result as GisInspection;
    if (Buffer.byteLength(JSON.stringify(result)) > GIS_LIMITS.inspectionBytes)
      throw new GisError(
        "GIS_INSPECTION_LIMIT",
        "The inspection inventory exceeds 1 MiB. Split the source into fewer layers/fields; no entries were omitted.",
        413,
      );
    return result;
  }
  async normalize(
    input: GisInput & { recipe: GisRecipe },
  ): Promise<GisNormalized> {
    const recipe = gisRecipeSchema.parse(input.recipe);
    const result = (await this.run("normalize", input, { recipe }))
      .result as GisNormalized;
    // Bind the exact JS-visible normalized object, not Python float spelling.
    result.provenance.normalizedSha256 = sha(canonicalJSON(result.geojson));
    sourceImportMetadataSchema.parse(result.provenance);
    return result;
  }
  async exportShapefile(input: {
    layers: GisExportLayer[];
    manifest: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<GisExportResult> {
    if (
      input.layers.length > 20 ||
      new Set(input.layers.map((layer) => layer.id)).size !==
        input.layers.length
    )
      throw new GisError(
        "GIS_EXPORT_LAYER",
        "Export up to 20 uniquely named geometry layers.",
      );
    const { result, zip } = await this.run(
      "export",
      undefined,
      { layers: input.layers, manifest: input.manifest },
      input.signal,
    );
    const value = result as {
      sha256: string;
      manifest: Record<string, unknown>;
    };
    return { zip: zip!, sha256: value.sha256, manifest: value.manifest };
  }
}

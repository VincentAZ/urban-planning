import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalJSON,
  createMediaScene,
  defaultMediaExportRecipe,
  mediaContentHash,
  prepareMediaTimeline,
  type MediaScene,
  type MediaExportRecipe,
  type MediaFrameReceipt,
  type Place,
} from "@urban/core";
import { createProject } from "@urban/models";

const subprocess = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: subprocess.spawn }));
import { MediaRuntime, MEDIA_RUNTIME_LIMITS } from "./media-runtime.js";

/** All subprocesses are mocked. These tests assert orchestration/integrity, never rendered pixels or a valid codec. */
class Child extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  closed = false;
  kill = vi.fn(() => {
    this.close(null);
    return true;
  });
  close(code: number | null = 0) {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    this.emit("close", code);
  }
}
type Request = {
  scene: MediaScene;
  recipe: MediaExportRecipe;
  frameCount: number;
  scheduledCameras: unknown[];
};
type Invocation = { args: string[]; child: Child };
const digest = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");
const image = `sha256:${"a".repeat(64)}`;
const roots: string[] = [];
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function sceneFixture() {
  const place: Place = {
    id: "media-runtime-fixture",
    name: "Synthetic runtime scene",
    city: "Test",
    state: "AZ",
    zip: "00000",
    center: [-112.07, 33.45],
    bounds: [-112.08, 33.44, -112.06, 33.46],
    boundary: [
      [-112.08, 33.44],
      [-112.06, 33.44],
      [-112.06, 33.46],
      [-112.08, 33.46],
      [-112.08, 33.44],
    ],
    buildings: [],
    roads: [],
    sources: [],
    coverage: [],
    loadedAt: "2026-11-06",
    extentLabel: "Synthetic fixture only",
  };
  const project = createProject(place),
    scenario = project.scenarios[1];
  scenario.presentation = {
    version: 1,
    title: "Synthetic two-stop tour",
    stops: [0, 1].map((i) => ({
      id: `stop-${i}`,
      title: `Stop ${i}`,
      callout: "Full retained text",
      view: "3d",
      camera: {
        center: [-112.07 + i * 0.001, 33.45 + i * 0.001],
        zoom: 15,
        pitch: 45,
        bearing: 0,
      },
    })),
  };
  const scene = createMediaScene({
    projectId: project.id,
    projectVersion: 1,
    place,
    scenario,
    results: {
      scenarioId: scenario.id,
      revision: scenario.revision,
      computedAt: "2026-11-06T00:00:00.000Z",
      modelVersion: "synthetic-test-only",
      metrics: [],
      warnings: [],
    },
    createdAt: "2026-11-06T00:00:00.000Z",
  });
  return { scene, recipe: defaultMediaExportRecipe(scene) };
}
function syntheticPng(width: number, height: number) {
  // The runtime checks signature/dimensions/hash; native tests separately decode actual PNGs.
  const bytes = Buffer.alloc(32);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
async function output(
  request: Request,
  directory: string,
  mutate?: (rows: MediaFrameReceipt[], png: Buffer) => void,
) {
  const timeline = prepareMediaTimeline(request.scene, request.recipe),
    png = syntheticPng(timeline.width, timeline.height);
  const rows = Array.from({ length: timeline.frameCount }, (_, index) => {
    const f = timeline.frameAt(index);
    return {
      index,
      timestampMicroseconds: f.timestampMicroseconds,
      durationMicroseconds: f.durationMicroseconds,
      sceneHash: timeline.sceneHash,
      recipeHash: timeline.recipeHash,
      generation: "synthetic-load",
      drawSerial: index + 1,
      requestedCamera: f.camera,
      actualCamera: structuredClone(f.camera),
      width: timeline.width,
      height: timeline.height,
      pixelHash: digest(png),
    };
  });
  mutate?.(rows, png);
  await writeFile(
    join(
      directory,
      request.recipe.format === "png" ? "output.png" : "thumbnail.png",
    ),
    png,
  );
  if (request.recipe.format === "mp4")
    await writeFile(
      join(directory, "output.mp4"),
      "Synthetic encoded bytes, not a codec fixture",
    );
  await writeFile(join(directory, "frames.json"), canonicalJSON(rows));
  await writeFile(
    join(directory, "response.json"),
    JSON.stringify({
      ok: true,
      frameCount: timeline.frameCount,
      width: timeline.width,
      height: timeline.height,
      chromium: "synthetic-1",
      ffmpeg: "synthetic-1",
    }),
  );
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "media-runtime-test-"));
  roots.push(root);
  const renderer = join(root, "renderer"),
    work = join(root, "work"),
    workerPath = join(root, "worker.mjs");
  await mkdir(join(renderer, "fonts"), { recursive: true });
  const assets = [
    {
      path: "media-render.html",
      body: Buffer.from("<html>Synthetic renderer fixture</html>"),
    },
    {
      path: "fonts/pinned.ttf",
      body: Buffer.from("Synthetic font inventory, never loaded in a browser"),
    },
  ];
  for (const f of assets) await writeFile(join(renderer, f.path), f.body);
  const base = {
    version: 1,
    profileVersion: "citymap-media-1.0.0",
    entry: "media-render.html",
    files: assets.map((f) => ({
      path: f.path,
      bytes: f.body.length,
      sha256: digest(f.body),
    })),
  };
  await writeFile(
    join(renderer, "renderer-manifest.json"),
    canonicalJSON({ ...base, rendererHash: mediaContentHash(base) }),
  );
  await writeFile(
    workerPath,
    "// Synthetic worker fixture; subprocess is always mocked.\n",
  );
  const calls: Invocation[] = [];
  let outgoing = "",
    incoming = "",
    uncertain = false;
  let start = async (child: Child, request: Request) => {
    await output(request, outgoing);
    child.close();
  };
  const failures: unknown[] = [];
  subprocess.spawn.mockImplementation(
    (bin: string, args: string[], options: { shell: boolean }) => {
      if (bin !== "docker" || options.shell !== false)
        throw new Error("Unexpected subprocess");
      const child = new Child();
      calls.push({ args: [...args], child });
      queueMicrotask(() => {
        void (async () => {
          if (args[0] === "image") {
            child.stdout.write(image + "\n");
            child.close();
          } else if (args[0] === "create") {
            for (const arg of args) {
              if (arg.startsWith("type=bind,src=")) {
                const parts = Object.fromEntries(
                  arg.split(",").map((x) => x.split("=")),
                );
                if (parts.dst === "/out") outgoing = parts.src;
                if (parts.dst === "/input") incoming = parts.src;
              }
            }
            child.stdout.write("synthetic-container-id\n");
            child.close();
          } else if (args[0] === "start")
            await start(
              child,
              JSON.parse(
                await readFile(join(incoming, "request.json"), "utf8"),
              ),
            );
          else if (args[0] === "rm") child.close();
          else if (args[0] === "ps") {
            if (uncertain) child.stdout.write("urban-media-still-running\n");
            child.close();
          } else throw new Error(`Unexpected docker command ${args[0]}`);
        })().catch((e) => {
          failures.push(e);
          child.stderr.write(String(e));
          child.close(1);
        });
      });
      return child;
    },
  );
  const runtime = new MediaRuntime({
    image,
    rendererDirectory: renderer,
    workRoot: work,
    workerPath,
  });
  const identity = await runtime.identity();
  return {
    root,
    renderer,
    work,
    workerPath,
    runtime,
    identity,
    calls,
    failures,
    assets,
    setStart(fn: typeof start) {
      start = fn;
    },
    setUncertain() {
      uncertain = true;
    },
    getOutput: () => outgoing,
    getInput: () => incoming,
  };
}
beforeEach(() => {
  subprocess.spawn.mockReset();
  vi.spyOn(process as { getuid: () => number }, "getuid").mockReturnValue(1000);
  vi.spyOn(process as { getgid: () => number }, "getgid").mockReturnValue(1000);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("media runtime boundary without native execution", () => {
  it("binds exact host cameras, pinned font/runtime metadata and hard container file limits", async () => {
    const f = await fixture(),
      s = sceneFixture();
    let observed: Request | undefined;
    f.setStart(async (child, request) => {
      observed = request;
      await output(request, f.getOutput());
      child.close();
    });
    const result = await f.runtime.execute({
      ...s,
      runtimeIdentity: f.identity,
      signal: new AbortController().signal,
      onProgress: async () => {},
    });
    expect(observed!.scheduledCameras).toEqual([
      prepareMediaTimeline(s.scene, s.recipe).frameAt(0).camera,
    ]);
    const manifest = JSON.parse(
      Buffer.from(result.files["manifest.json"]).toString(),
    );
    expect(manifest.runtime).toEqual({
      profileVersion: f.identity.profileVersion,
      hash: f.identity.runtimeHash,
    });
    expect(manifest.renderer.profileHash).toBe(f.identity.rendererHash);
    expect(manifest.renderer.fontHashes).toEqual([digest(f.assets[1].body)]);
    expect(manifest.encoder).toBeNull();
    const args = f.calls.find((c) => c.args[0] === "create")!.args;
    for (const flag of [
      "--pull=never",
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "no-new-privileges",
      "--pids-limit=256",
    ])
      expect(args).toContain(flag);
    expect(args).toContain(
      `fsize=${MEDIA_RUNTIME_LIMITS.outputBytes}:${MEDIA_RUNTIME_LIMITS.outputBytes}`,
    );
    expect(args[args.indexOf("--memory") + 1]).toBe(
      String(MEDIA_RUNTIME_LIMITS.memoryBytes),
    );
    expect(f.calls.some((c) => c.args[0] === "ps")).toBe(true);
    expect(await readdir(f.work)).toEqual([]);
    expect(f.failures).toEqual([]);
  });
  it("refuses changed renderer bytes and symlink assets before creating a native process", async () => {
    const f = await fixture();
    f.calls.length = 0;
    await writeFile(join(f.renderer, "media-render.html"), "altered bytes");
    await expect(f.runtime.identity()).rejects.toMatchObject({
      code: "MEDIA_RENDERER_CHANGED",
    });
    expect(f.calls).toEqual([]);
    await rm(join(f.renderer, "media-render.html"));
    await writeFile(join(f.root, "outside.html"), f.assets[0].body);
    await symlink(
      join(f.root, "outside.html"),
      join(f.renderer, "media-render.html"),
    );
    await expect(f.runtime.identity()).rejects.toMatchObject({
      code: "MEDIA_FILE_INVALID",
    });
    expect(f.calls).toEqual([]);
  });
  it("refuses changed worker identity after admission without starting a container", async () => {
    const f = await fixture(),
      s = sceneFixture();
    f.calls.length = 0;
    await writeFile(f.workerPath, "// Changed worker implementation\n");
    await expect(
      f.runtime.execute({
        ...s,
        runtimeIdentity: f.identity,
        signal: new AbortController().signal,
        onProgress: async () => {},
      }),
    ).rejects.toMatchObject({ code: "MEDIA_RENDERER_CHANGED" });
    expect(
      f.calls.some((c) => c.args[0] === "create" || c.args[0] === "start"),
    ).toBe(false);
  });
  it.each(["png", "mp4"] as const)(
    "rejects a substituted %s first-image file even with complete valid frame receipts",
    async (format) => {
      const f = await fixture(),
        { scene } = sceneFixture();
      let recipe = defaultMediaExportRecipe(scene, format);
      if (recipe.format === "mp4")
        recipe = {
          ...recipe,
          stops: recipe.stops.map((s) => ({
            ...s,
            holdFrames: 1,
            transitionFrames: 0,
          })),
        };
      f.setStart(async (child, request) => {
        await output(request, f.getOutput(), (_r, png) => {
          png[31] = 1;
        });
        child.close();
      });
      await expect(
        f.runtime.execute({
          scene,
          recipe,
          runtimeIdentity: f.identity,
          signal: new AbortController().signal,
          onProgress: async () => {},
        }),
      ).rejects.toMatchObject({ code: "MEDIA_IMAGE_MISMATCH" });
      expect(await readdir(f.work)).toEqual([]);
    },
  );
  it("rejects incomplete or wrong-camera receipt ledgers before retaining any artifact", async () => {
    const f = await fixture(),
      s = sceneFixture();
    f.setStart(async (child, request) => {
      await output(request, f.getOutput(), (rows) => {
        rows[0].requestedCamera.zoom += 0.01;
      });
      child.close();
    });
    await expect(
      f.runtime.execute({
        ...s,
        runtimeIdentity: f.identity,
        signal: new AbortController().signal,
        onProgress: async () => {},
      }),
    ).rejects.toThrow(/frozen timeline/);
    expect(await readdir(f.work)).toEqual([]);
  });
  it("rejects an oversized sparse output before reading its bytes", async () => {
    const f = await fixture(),
      s = sceneFixture();
    f.setStart(async (child, request) => {
      await output(request, f.getOutput());
      await truncate(
        join(f.getOutput(), "output.png"),
        MEDIA_RUNTIME_LIMITS.outputBytes + 1,
      );
      child.close();
    });
    await expect(
      f.runtime.execute({
        ...s,
        runtimeIdentity: f.identity,
        signal: new AbortController().signal,
        onProgress: async () => {},
      }),
    ).rejects.toMatchObject({ code: "MEDIA_FILE_INVALID" });
    expect(await readdir(f.work)).toEqual([]);
  });
  it.each([
    {
      bytes: Buffer.from("unstructured worker output\n"),
      code: "MEDIA_PROGRESS_INVALID",
    },
    {
      bytes: Buffer.from('{"stage":"rendering","completedFrames":30001}\n'),
      code: "MEDIA_PROGRESS_INVALID",
    },
    { bytes: Buffer.alloc(256 * 1024 + 1, 65), code: "MEDIA_OUTPUT_LIMIT" },
  ])(
    "terminates malformed or unbounded worker output ($code)",
    async ({ bytes, code }) => {
      const f = await fixture(),
        s = sceneFixture(),
        onProgress = vi.fn(async () => {});
      f.setStart(async (child) => {
        child.stdout.write(bytes);
      });
      await expect(
        f.runtime.execute({
          ...s,
          runtimeIdentity: f.identity,
          signal: new AbortController().signal,
          onProgress,
        }),
      ).rejects.toMatchObject({ code });
      expect(onProgress).not.toHaveBeenCalled();
      expect(
        f.calls.find((c) => c.args[0] === "start")!.child.kill,
      ).toHaveBeenCalledWith("SIGKILL");
      expect(await readdir(f.work)).toEqual([]);
    },
  );
  it("aborts a hung progress acknowledgment after process exit and suppresses queued late callbacks", async () => {
    const f = await fixture(),
      s = sceneFixture(),
      entered = deferred(),
      release = deferred(),
      controller = new AbortController();
    f.setStart(async (child) => {
      child.stdout.write(
        '{"stage":"rendering","completedFrames":0}\n{"stage":"verifying","completedFrames":1}\n',
      );
      child.close();
    });
    const progress = vi.fn(async () => {
      entered.resolve();
      await release.promise;
    });
    const execution = f.runtime.execute({
      ...s,
      runtimeIdentity: f.identity,
      signal: controller.signal,
      onProgress: progress,
    });
    const outcome = execution.then(
      () => ({ code: "unexpected-success" }),
      (e) => e,
    );
    await entered.promise;
    controller.abort();
    try {
      const result = await Promise.race([
        outcome,
        new Promise((resolve) =>
          setTimeout(() => resolve({ code: "test-detected-hang" }), 250),
        ),
      ]);
      expect(result).toMatchObject({ code: "MEDIA_CANCELLED" });
      expect(f.calls.some((c) => c.args[0] === "rm")).toBe(true);
      expect(await readdir(f.work)).toEqual([]);
    } finally {
      release.resolve();
      await outcome;
    }
    expect(progress).toHaveBeenCalledTimes(1);
  });
  it("keeps the hard run deadline active while a closed process has an unresolved progress callback", async () => {
    const f = await fixture(),
      s = sceneFixture(),
      entered = deferred(),
      release = deferred();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    f.setStart(async (child) => {
      child.stdout.write('{"stage":"rendering","completedFrames":0}\n');
      child.close();
    });
    const execution = f.runtime.execute({
      ...s,
      runtimeIdentity: f.identity,
      signal: new AbortController().signal,
      onProgress: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const outcome = execution.then(
      () => ({ code: "unexpected-success" }),
      (e) => e,
    );
    await entered.promise;
    try {
      await vi.advanceTimersByTimeAsync(MEDIA_RUNTIME_LIMITS.milliseconds);
      expect(await outcome).toMatchObject({ code: "MEDIA_TIMEOUT" });
    } finally {
      release.resolve();
      await outcome;
      vi.useRealTimers();
    }
    expect(await readdir(f.work)).toEqual([]);
  });
  it("preserves the workspace and blocks runtime reuse when container absence cannot be proved", async () => {
    const f = await fixture(),
      s = sceneFixture(),
      entered = deferred(),
      controller = new AbortController();
    f.setUncertain();
    f.setStart(async () => {
      entered.resolve();
    });
    const execution = f.runtime.execute({
      ...s,
      runtimeIdentity: f.identity,
      signal: controller.signal,
      onProgress: async () => {},
    });
    const outcome = execution.then(
      () => ({ code: "unexpected-success" }),
      (e) => e,
    );
    await entered.promise;
    controller.abort();
    expect(await outcome).toMatchObject({ code: "NATIVE_CLEANUP_UNCONFIRMED" });
    expect((await readdir(f.work)).length).toBe(1);
    await expect(
      f.runtime.execute({
        ...s,
        runtimeIdentity: f.identity,
        signal: new AbortController().signal,
        onProgress: async () => {},
      }),
    ).rejects.toMatchObject({ code: "MEDIA_RUNTIME_BUSY" });
  });
});

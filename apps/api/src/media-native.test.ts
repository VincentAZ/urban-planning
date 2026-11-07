import { housingFixture } from "../../../packages/models/src/housing-fixture";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  assertMediaExportManifest,
  assertMediaFrameReceipts,
  createMediaScene,
  defaultMediaExportRecipe,
  prepareMediaTimeline,
  mediaTranscript,
  mediaWebVtt,
  type MediaExportManifest,
  type MediaExportRecipe,
  type MediaFrameReceipt,
  type MediaScene,
} from "@urban/core";
import { calculateImpact } from "@urban/models";
import { MediaRuntime } from "./media-runtime.js";
import type {
  MediaExecutionResult,
  MediaRuntimeIdentity,
} from "./media-types.js";
import { createMediaNativeSceneFixture } from "./media-test-fixture.js";
import { fiscalReportFixture } from "./fiscal-report-fixture.js";

const exec = promisify(execFile);
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const NATIVE_TIMEOUT = 900000;
type Inspection = {
  Id: string;
  State: { Running: boolean };
  Mounts: { Source: string }[];
};

// Explicit opt-in only. These tests launch the actual offline Chromium/FFmpeg
// runtime over fabricated test geometry; neither the executor nor pixels are mocked.
describe.skipIf(process.env.MEDIA_NATIVE_TESTS !== "1")(
  "actual isolated CityMap media runtime",
  () => {
    let directory: string,
      evidence: string,
      image: string,
      runtime: MediaRuntime,
      identity: MediaRuntimeIdentity,
      scene: MediaScene;
    const controllers = new Set<AbortController>();
    const pending = new Set<Promise<unknown>>();
    const localTools = new Map<string, boolean>();

    async function ownedContainers(): Promise<Inspection[]> {
      const { stdout } = await exec(
        "docker",
        [
          "ps",
          "--all",
          "--filter",
          "label=urban-planning.service=media",
          "--format",
          "{{.ID}}",
        ],
        { timeout: 5000, maxBuffer: 65536 },
      );
      const ids = stdout.trim().split(/\s+/).filter(Boolean);
      if (!ids.length) return [];
      if (ids.length > 32)
        throw new Error(
          "Too many media containers to inspect safely in native QA.",
        );
      const result = await exec("docker", ["inspect", ...ids], {
        timeout: 5000,
        maxBuffer: 2 * 1024 ** 2,
      });
      return (JSON.parse(result.stdout) as Inspection[]).filter((container) =>
        container.Mounts.some((mount) =>
          mount.Source.startsWith(directory + sep),
        ),
      );
    }
    async function cleanRuntime() {
      expect(await ownedContainers()).toEqual([]);
      expect(await readdir(join(directory, "work"))).toEqual([]);
    }
    async function tool(
      name: "ffprobe" | "ffmpeg",
      args: string[],
    ): Promise<Buffer> {
      if (!localTools.has(name)) {
        try {
          await exec(name, ["-version"], { timeout: 5000, maxBuffer: 65536 });
          localTools.set(name, true);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          localTools.set(name, false);
        }
      }
      if (localTools.get(name)) {
        const result = await exec(name, args, {
          timeout: 15000,
          maxBuffer: 2 * 1024 ** 2,
          encoding: "buffer",
        });
        return result.stdout;
      }
      // Only if the independent host tool is absent, use the pinned image with
      // this test's evidence directory mounted read-only and no network access.
      const container = `urban-media-native-probe-${randomUUID()}`;
      try {
        const result = await exec(
          "docker",
          [
            "run",
            "--rm",
            "--pull=never",
            "--name",
            container,
            "--network=none",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt",
            "no-new-privileges",
            "--memory=256m",
            "--cpus=1",
            "--pids-limit=64",
            "--user",
            `${process.getuid!()}:${process.getgid!()}`,
            "--mount",
            `type=bind,src=${evidence},dst=/input,readonly`,
            "--entrypoint",
            name,
            image,
            ...args.map((arg) =>
              arg.startsWith(evidence + sep)
                ? `/input/${arg.slice(evidence.length + 1)}`
                : arg,
            ),
          ],
          { timeout: 15000, maxBuffer: 2 * 1024 ** 2, encoding: "buffer" },
        );
        return result.stdout;
      } finally {
        await exec("docker", ["rm", "--force", container], {
          timeout: 5000,
          maxBuffer: 65536,
        }).catch(() => {});
        const remaining = await exec(
          "docker",
          [
            "ps",
            "--all",
            "--filter",
            `name=^/${container}$`,
            "--format",
            "{{.Names}}",
          ],
          { timeout: 5000, maxBuffer: 65536 },
        );
        expect(remaining.stdout.trim()).toBe("");
      }
    }
    function run(
      recipe: MediaExportRecipe,
      controller = new AbortController(),
      progress: (
        stage: string,
        frames: number,
      ) => Promise<void> = async () => {},
      frozenScene: MediaScene = scene,
    ) {
      controllers.add(controller);
      const task = runtime.execute({
        scene: frozenScene,
        recipe,
        runtimeIdentity: identity,
        signal: controller.signal,
        onProgress: progress,
      });
      pending.add(task);
      void task.then(
        () => {
          pending.delete(task);
          controllers.delete(controller);
        },
        () => {
          pending.delete(task);
          controllers.delete(controller);
        },
      );
      return task;
    }
    function verify(
      recipe: MediaExportRecipe,
      result: MediaExecutionResult,
      frozenScene: MediaScene = scene,
    ) {
      const manifest = JSON.parse(
        Buffer.from(result.files["manifest.json"]).toString(),
      ) as MediaExportManifest;
      const receipts = JSON.parse(
        Buffer.from(result.files["frames.json"]).toString(),
      ) as MediaFrameReceipt[];
      expect(() =>
        assertMediaExportManifest(frozenScene, recipe, manifest, receipts),
      ).not.toThrow();
      expect(() =>
        assertMediaFrameReceipts(
          prepareMediaTimeline(frozenScene, recipe),
          receipts,
        ),
      ).not.toThrow();
      expect(manifest.runtime).toEqual({
        profileVersion: identity.profileVersion,
        hash: identity.runtimeHash,
      });
      expect(manifest.renderer.profileHash).toBe(identity.rendererHash);
      expect(manifest.renderer.fontHashes).toHaveLength(2);
      expect(manifest.frameReceiptsHash).toBe(sha(result.files["frames.json"]));
      expect(Object.keys(result.files).sort()).toEqual(
        [...manifest.files.map((file) => file.name), "manifest.json"].sort(),
      );
      for (const file of manifest.files) {
        expect(result.files[file.name].byteLength).toBe(file.bytes);
        expect(sha(result.files[file.name])).toBe(file.sha256);
        expect(result.contentTypes[file.name]).toBe(file.contentType);
      }
      expect(Buffer.from(result.files["transcript.txt"]).toString()).toBe(
        mediaTranscript(frozenScene, recipe),
      );
      expect(Buffer.from(result.files["captions.vtt"]).toString()).toBe(
        mediaWebVtt(frozenScene, recipe),
      );
      return { manifest, receipts };
    }
    beforeAll(async () => {
      image =
        process.env.MEDIA_TEST_IMAGE_ID?.trim() ||
        (
          await readFile(resolve(".local/qa/media/runtime-image.id"), "utf8")
        ).trim();
      expect(image).toMatch(/^sha256:[a-f0-9]{64}$/);
      if (!process.getuid?.())
        throw new Error("Native media QA must run as a nonroot service user.");
      directory = await mkdtemp(join(tmpdir(), "urban-media-native-"));
      evidence = join(directory, "evidence");
      await mkdir(evidence);
      await mkdir(join(directory, "work"));
      runtime = new MediaRuntime({
        image,
        rendererDirectory: resolve("dist/media-render"),
        workRoot: join(directory, "work"),
      });
      identity = await runtime.identity();
      scene = createMediaNativeSceneFixture();
    }, 30000);
    afterAll(async () => {
      for (const controller of controllers) controller.abort();
      await Promise.allSettled([...pending]);
      if (!directory) return;
      // Do not erase source mounts if the runtime failed to prove its owned native
      // processes stopped. Such a failure needs explicit operator investigation.
      expect(
        await ownedContainers(),
        `Owned media container remains; retained test work: ${directory}`,
      ).toEqual([]);
      await rm(directory, { recursive: true, force: true });
    }, 30000);

    it(
      "renders actual 4K PNG pixels and complete immutable receipts without losing attribution",
      async () => {
        const recipe = defaultMediaExportRecipe(scene, "png");
        recipe.width = 3840;
        recipe.height = 2160;
        if (recipe.format !== "png") throw new Error("Expected still recipe");
        recipe.caption =
          "Actual 4K renderer verification using synthetic geometry.";
        const result = await run(recipe),
          { manifest, receipts } = verify(recipe, result);
        const png = Buffer.from(result.files["output.png"]);
        expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
        expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([
          3840, 2160,
        ]);
        expect(receipts).toHaveLength(1);
        expect(receipts[0]).toMatchObject({
          index: 0,
          width: 3840,
          height: 2160,
          pixelHash: sha(png),
        });
        expect(manifest.encoder).toBeNull();
        expect(
          manifest.sources.some(
            ({ source }) =>
              source.name === "Synthetic native media test source",
          ),
        ).toBe(true);
        const path = join(evidence, "still.png");
        await writeFile(path, png);
        // Inspect only the map region, so captions/credits cannot make a blank map pass.
        const rgb = await tool("ffmpeg", [
          "-v",
          "error",
          "-i",
          path,
          "-vf",
          "crop=iw:floor(ih*0.72):0:0,scale=128:72",
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "pipe:1",
        ]);
        expect(rgb.length).toBe(128 * 72 * 3);
        const colors = new Set<string>();
        for (let i = 0; i < rgb.length; i += 3)
          colors.add(`${rgb[i] >> 4}:${rgb[i + 1] >> 4}:${rgb[i + 2] >> 4}`);
        expect(colors.size).toBeGreaterThan(6);
        await cleanRuntime();
      },
      NATIVE_TIMEOUT,
    );

    it(
      "renders a frozen fiscal study with exact profile attribution and no original-project history",
      async () => {
        const fiscal = fiscalReportFixture();
        const frozen = createMediaScene({
          projectId: fiscal.project.id,
          projectVersion: 1,
          place: fiscal.place,
          scenario: fiscal.scenario,
          results: fiscal.results,
          fiscalStudy: fiscal.project.fiscalStudy,
          createdAt: fiscal.generatedAt,
        });
        const recipe = defaultMediaExportRecipe(frozen, "png");
        const result = await run(
          recipe,
          new AbortController(),
          async () => {},
          frozen,
        );
        const { manifest, receipts } = verify(recipe, result, frozen);
        const png = Buffer.from(result.files["output.png"]);
        expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
        expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([
          1920, 1080,
        ]);
        expect(receipts[0].pixelHash).toBe(sha(png));
        expect(frozen.binding.fiscalProfileHash).toBe(
          fiscal.project.fiscalStudy!.profileHash,
        );
        expect(frozen.results.fiscal).toEqual(fiscal.results.fiscal);
        expect(manifest.sources).toContainEqual(
          expect.objectContaining({
            namespace: "fiscal-profile",
            source: fiscal.project.fiscalStudy!.profile.sources[0],
          }),
        );
        expect(JSON.stringify(frozen)).not.toContain(
          fiscal.project.fiscalStudy!.lineage.projectId,
        );
        expect(JSON.stringify(frozen)).not.toContain('"historyHash"');
        await cleanRuntime();
      },
      NATIVE_TIMEOUT,
    );

    it(
      "renders a frozen housing comparison with exact selected limits and authored costs",
      async () => {
        const housing = housingFixture();
        const results = calculateImpact(
          housing.place,
          housing.scenario,
          {},
          { housingIncomeLimits: housing.project.housingIncomeLimits },
        );
        const frozen = createMediaScene({
          projectId: housing.project.id,
          projectVersion: 1,
          place: housing.place,
          scenario: housing.scenario,
          results,
          housingIncomeLimits: housing.project.housingIncomeLimits,
          createdAt: results.computedAt,
        });
        const recipe = defaultMediaExportRecipe(frozen, "png");
        const result = await run(
          recipe,
          new AbortController(),
          async () => {},
          frozen,
        );
        const { manifest, receipts } = verify(recipe, result, frozen);
        const png = Buffer.from(result.files["output.png"]);
        expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
        expect(receipts[0].pixelHash).toBe(sha(png));
        expect(frozen.housingIncomeLimits).toEqual({
          [housing.areaHash]: housing.pack,
        });
        expect(frozen.scenario.affordability).toEqual(
          housing.scenario.affordability,
        );
        expect(manifest.sources).toContainEqual(
          expect.objectContaining({
            namespace: `housing-income-limits:${housing.areaHash}`,
            source: housing.pack.sources[0],
          }),
        );
        expect(manifest.sources).toContainEqual(
          expect.objectContaining({
            namespace: "housing-costs",
            source: housing.source,
          }),
        );
        expect(JSON.stringify(frozen)).not.toContain('"history"');
        await cleanRuntime();
      },
      NATIVE_TIMEOUT,
    );

    it(
      "changes pitched 3D geometry pixels for height alone while preserving the same 2D plan",
      async () => {
        const pixels = new Map<string, Buffer>();
        for (const height of [1, 80]) {
          const place = structuredClone(scene.place);
          place.buildings[0].height = height;
          const scenario = structuredClone(scene.scenario);
          const frozen = createMediaScene({
            projectId: scene.binding.projectId,
            projectVersion: 1,
            place,
            scenario,
            results: calculateImpact(place, scenario),
            createdAt: scene.createdAt,
          });
          for (const view of ["2d", "3d"] as const) {
            const recipe = defaultMediaExportRecipe(frozen, "png");
            if (recipe.format !== "png")
              throw new Error("Expected still recipe");
            recipe.camera = {
              center: [-112.072, 33.455],
              zoom: 18.5,
              pitch: view === "3d" ? 55 : 0,
              bearing: -27,
            };
            recipe.view = view;
            recipe.layers = ["buildings"];
            recipe.caption =
              "Synthetic height-only native geometry verification.";
            const output = await run(recipe, undefined, undefined, frozen);
            verify(recipe, output, frozen);
            const path = join(evidence, `height-${height}-${view}.png`);
            await writeFile(path, output.files["output.png"]);
            pixels.set(
              `${height}-${view}`,
              await tool("ffmpeg", [
                "-v",
                "error",
                "-i",
                path,
                "-vf",
                "crop=iw:floor(ih*0.72):0:0,scale=256:144",
                "-frames:v",
                "1",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "pipe:1",
              ]),
            );
          }
        }
        expect(pixels.get("1-2d")).toEqual(pixels.get("80-2d"));
        const low = pixels.get("1-3d")!,
          high = pixels.get("80-3d")!;
        expect(low.length).toBe(256 * 144 * 3);
        expect(high.length).toBe(low.length);
        let changed = 0;
        for (let i = 0; i < low.length; i += 3)
          if (
            Math.max(
              ...[0, 1, 2].map((c) => Math.abs(low[i + c] - high[i + c])),
            ) > 16
          )
            changed++;
        expect(changed).toBeGreaterThan(100);
        await cleanRuntime();
      },
      NATIVE_TIMEOUT,
    );

    it(
      "encodes exact interior camera frames and declared reused holds into an independently probed silent MP4",
      async () => {
        const recipe = defaultMediaExportRecipe(scene, "mp4");
        if (recipe.format !== "mp4") throw new Error("Expected movie recipe");
        recipe.width = 1280;
        recipe.height = 720;
        recipe.stops = recipe.stops.map((stop, i) => ({
          ...stop,
          holdFrames: 3,
          transitionFrames: i === 0 ? 3 : 0,
        }));
        const result = await run(recipe),
          { manifest, receipts } = verify(recipe, result),
          timeline = prepareMediaTimeline(scene, recipe);
        expect(receipts).toHaveLength(9);
        expect(receipts.map((frame) => frame.reusedFromFrame)).toEqual([
          undefined,
          0,
          0,
          undefined,
          undefined,
          undefined,
          undefined,
          6,
          6,
        ]);
        expect(receipts.map((frame) => frame.requestedCamera)).toEqual(
          Array.from({ length: 9 }, (_, i) => timeline.frameAt(i).camera),
        );
        expect(receipts.map((frame) => frame.timestampMicroseconds)).toEqual([
          0, 33333, 66666, 100000, 133333, 166666, 200000, 233333, 266666,
        ]);
        expect(
          new Set(receipts.slice(3, 6).map((frame) => frame.pixelHash)).size,
        ).toBe(3);
        expect(receipts[0].requestedCamera).toEqual(
          scene.scenario.presentation!.stops[0].camera,
        );
        expect(receipts[6].requestedCamera).toEqual(
          scene.scenario.presentation!.stops[1].camera,
        );
        expect(manifest.duration).toEqual({ numerator: 9, denominator: 30 });
        const movie = Buffer.from(result.files["output.mp4"]);
        expect(movie.subarray(4, 8).toString()).toBe("ftyp");
        expect(sha(result.files["thumbnail.png"])).toBe(receipts[0].pixelHash);
        const path = join(evidence, "movie.mp4");
        await writeFile(path, movie);
        const probe = JSON.parse(
          (
            await tool("ffprobe", [
              "-v",
              "error",
              "-count_frames",
              "-show_streams",
              "-show_format",
              "-of",
              "json",
              path,
            ])
          ).toString(),
        );
        expect(probe.streams).toHaveLength(1);
        expect(probe.streams[0]).toMatchObject({
          codec_name: "h264",
          codec_type: "video",
          width: 1280,
          height: 720,
          pix_fmt: "yuv420p",
          r_frame_rate: "30/1",
          avg_frame_rate: "30/1",
          nb_read_frames: "9",
        });
        expect(Number(probe.streams[0].duration)).toBeCloseTo(0.3, 6);
        const decoded = JSON.parse(
          (
            await tool("ffprobe", [
              "-v",
              "error",
              "-select_streams",
              "v:0",
              "-show_frames",
              "-show_entries",
              "frame=best_effort_timestamp_time",
              "-of",
              "json",
              path,
            ])
          ).toString(),
        );
        expect(decoded.frames).toHaveLength(9);
        decoded.frames.forEach(
          (frame: { best_effort_timestamp_time: string }, i: number) =>
            expect(Number(frame.best_effort_timestamp_time)).toBeCloseTo(
              i / 30,
              5,
            ),
        );
        const rgb = await tool("ffmpeg", [
          "-v",
          "error",
          "-i",
          path,
          "-vf",
          "crop=iw:floor(ih*0.72):0:0,scale=128:72",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "pipe:1",
        ]);
        const frameBytes = 128 * 72 * 3;
        expect(rgb.length).toBe(9 * frameBytes);
        // Verify encoded movement itself; valid receipts alone cannot prove the
        // encoder was fed different images. Do not compare lossy pixels to PNG hashes.
        expect(
          new Set(
            [3, 4, 5].map((index) =>
              sha(rgb.subarray(index * frameBytes, (index + 1) * frameBytes)),
            ),
          ).size,
        ).toBe(3);
        await cleanRuntime();
      },
      NATIVE_TIMEOUT,
    );

    it(
      "cancels an actually rendering movie, confirms all owned processes and scratch are gone, then reuses the runtime",
      async () => {
        const recipe = defaultMediaExportRecipe(scene, "mp4");
        if (recipe.format !== "mp4") throw new Error("Expected movie recipe");
        recipe.width = 1280;
        recipe.height = 720;
        recipe.stops = recipe.stops.map((stop, i) => ({
          ...stop,
          holdFrames: 1,
          transitionFrames: i === 0 ? 300 : 0,
        }));
        const controller = new AbortController();
        let active: Inspection[] = [],
          reached = false;
        const task = run(recipe, controller, async (stage, frames) => {
          if (stage !== "rendering" || frames < 1 || reached) return;
          reached = true;
          active = await ownedContainers();
          controller.abort();
        });
        await expect(task).rejects.toMatchObject({ code: "MEDIA_CANCELLED" });
        expect(reached).toBe(true);
        expect(active).toHaveLength(1);
        expect(active[0].State.Running).toBe(true);
        await cleanRuntime();
        const still = defaultMediaExportRecipe(scene, "png");
        still.width = 1920;
        still.height = 1080;
        const next = await run(still);
        verify(still, next);
        const png = Buffer.from(next.files["output.png"]);
        expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([
          1920, 1080,
        ]);
        await cleanRuntime();
      },
      NATIVE_TIMEOUT,
    );
  },
);

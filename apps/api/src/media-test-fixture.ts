import { createHash } from "node:crypto";
import {
  canonicalJSON,
  mediaContentHash,
  mediaFrameCount,
  mediaFrameAt,
  mediaLayout,
  mediaTranscript,
  mediaWebVtt,
  MEDIA_METHOD_VERSION,
  type MediaExportManifest,
  createMediaScene,
  type Place,
  type MediaScene,
} from "@urban/core";
import { buildingPreset, calculateImpact, createProject } from "@urban/models";
import type { MediaExecutor } from "./media-types.js";
/** Small labeled geometry for the real native renderer tests; no executor or pixels are substituted. */
export function createMediaNativeSceneFixture(): MediaScene {
  const place: Place = {
    id: "media-native-synthetic",
    name: "Synthetic native media scene",
    city: "QA only",
    state: "AZ",
    zip: "00000",
    center: [-112.0715, 33.455],
    bounds: [-112.076, 33.451, -112.067, 33.459],
    boundary: [
      [-112.076, 33.451],
      [-112.067, 33.451],
      [-112.067, 33.459],
      [-112.076, 33.459],
      [-112.076, 33.451],
    ],
    buildings: [
      {
        ...buildingPreset("multifamily", [-112.072, 33.455]),
        id: "media-homes",
        name: "Synthetic homes",
        sourceId: "media-native-source",
      },
      {
        ...buildingPreset("office", [-112.071, 33.4545]),
        id: "media-office",
        name: "Synthetic office",
        sourceId: "media-native-source",
      },
    ],
    roads: [
      {
        id: "media-street",
        name: "Synthetic street",
        coordinates: [
          [-112.074, 33.4547],
          [-112.069, 33.4547],
        ],
        lanes: 2,
        speedMph: 25,
        oneWay: false,
        kind: "residential",
        sourceId: "media-native-source",
      },
    ],
    sources: [
      {
        id: "media-native-source",
        name: "Synthetic native media test source",
        url: "",
        vintage: "2026 test",
        license: "Synthetic QA fixture only",
        kind: "user-supplied",
        description:
          "Fabricated geography for actual renderer verification. No observed city, calibrated traffic or production capacity claim.",
      },
    ],
    coverage: [],
    loadedAt: "2026-11-06T00:00:00.000Z",
    extentLabel: "Synthetic native media QA area",
  };
  const project = createProject(place),
    scenario = project.scenarios.find(
      (s) => s.id === project.activeScenarioId,
    )!;
  scenario.presentation = {
    version: 1,
    title: "Synthetic two-stop native tour",
    stops: [
      {
        id: "native-first",
        title: "Synthetic homes",
        callout:
          "Retained synthetic building geometry. This is an actual 3D render, not an observed city.",
        narration:
          "The complete authored narration remains text; no audio is generated.",
        view: "3d",
        camera: {
          center: [-112.0718, 33.455],
          zoom: 17,
          pitch: 45,
          bearing: -27,
        },
        metricIds: ["housing.units"],
      },
      {
        id: "native-last",
        title: "Synthetic workplace",
        callout:
          "The same frozen scene from a second perspective, with original source attribution retained.",
        view: "3d",
        camera: {
          center: [-112.0712, 33.4547],
          zoom: 17.35,
          pitch: 53,
          bearing: 25,
        },
        metricIds: ["housing.units", "missing.metric"],
      },
    ],
  };
  return createMediaScene({
    projectId: project.id,
    projectVersion: 1,
    place,
    scenario,
    results: calculateImpact(place, scenario),
    createdAt: "2026-11-06T12:00:00.000Z",
  });
}
/** Synthetic executor only: lifecycle tests do not claim browser rendering or a valid encoded image. */
export class FixtureMediaExecutor implements MediaExecutor {
  calls = 0;
  beforeExecute?: () => Promise<void>;
  fail?: Error;
  changed = false;
  async identity() {
    return {
      profileVersion: "synthetic-media-fixture-1",
      rendererHash: (this.changed ? "c" : "a").repeat(64),
      runtimeHash: "b".repeat(64),
    };
  }
  async execute({
    scene,
    recipe,
    onProgress,
    signal,
  }: Parameters<MediaExecutor["execute"]>[0]) {
    this.calls++;
    await this.beforeExecute?.();
    if (this.fail) throw this.fail;
    if (signal.aborted) throw new Error("fixture cancelled");
    await onProgress("rendering", mediaFrameCount(recipe));
    const main = recipe.format === "png" ? "output.png" : "output.mp4";
    const files: Record<string, Uint8Array> = {
      [main]: Buffer.from("explicit synthetic encoded artifact"),
      "frames.json": Buffer.from(
        canonicalJSON(
          Array.from({ length: mediaFrameCount(recipe) }, (_, index) => {
            const f = mediaFrameAt(scene, recipe, index);
            return {
              index,
              sceneHash: scene.sceneHash,
              recipeHash: mediaContentHash(recipe),
              generation: "synthetic-load",
              drawSerial: index + 1,
              requestedCamera: f.camera,
              actualCamera: f.camera,
              width: recipe.width,
              height: recipe.height,
              pixelHash: "f".repeat(64),
              timestampMicroseconds: f.timestampMicroseconds,
              durationMicroseconds: f.durationMicroseconds,
            };
          }),
        ),
      ),
      "transcript.txt": Buffer.from(mediaTranscript(scene, recipe)),
      "captions.vtt": Buffer.from(mediaWebVtt(scene, recipe)),
    };
    const contentTypes: Record<string, string> = {
      [main]: recipe.format === "png" ? "image/png" : "video/mp4",
      "frames.json": "application/json",
      "transcript.txt": "text/plain; charset=utf-8",
      "captions.vtt": "text/vtt; charset=utf-8",
      "manifest.json": "application/json",
    };
    const sha = (x: Uint8Array) => createHash("sha256").update(x).digest("hex");
    const manifest: MediaExportManifest = {
      runtime: {
        profileVersion: (await this.identity()).profileVersion,
        hash: (await this.identity()).runtimeHash,
      },
      version: 1,
      methodVersion: MEDIA_METHOD_VERSION,
      sceneHash: scene.sceneHash,
      binding: scene.binding,
      recipe,
      recipeHash: mediaContentHash(recipe),
      frameCount: mediaFrameCount(recipe),
      duration: {
        numerator: recipe.format === "mp4" ? mediaFrameCount(recipe) : 0,
        denominator: recipe.format === "mp4" ? recipe.fps : 1,
      },
      layout: mediaLayout(recipe),
      frameReceiptsHash: sha(files["frames.json"]),
      renderer: {
        name: "synthetic fixture",
        version: "1",
        profileHash: "a".repeat(64),
        fontHashes: [],
      },
      encoder:
        recipe.format === "mp4"
          ? {
              name: "synthetic encoder",
              version: "1",
              profileHash: (await this.identity()).runtimeHash,
            }
          : null,
      files: Object.entries(files).map(([name, b]) => ({
        name,
        sha256: sha(b),
        bytes: b.byteLength,
        contentType: contentTypes[name],
      })),
      sources: scene.sources,
      notes: [
        "Synthetic lifecycle fixture; no rendered-pixel or codec assertion.",
      ],
    };
    files["manifest.json"] = Buffer.from(canonicalJSON(manifest));
    return { files, contentTypes };
  }
}
